import os
import re
from datetime import datetime, timedelta, timezone
from functools import wraps

import bcrypt
import jwt
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from supabase import create_client

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__)
CORS(app)

JWT_SECRET = os.getenv('JWT_SECRET', 'polaris-dev-secret')
PORT = int(os.getenv('PORT', 3001))

supabase = create_client(
    os.getenv('SUPABASE_URL'),
    os.getenv('SUPABASE_SECRET_KEY'),
)

EMAIL_RE = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')


# ── Auth middleware ────────────────────────────────────────────────────────────

def require_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        header = request.headers.get('Authorization', '')
        if not header.startswith('Bearer '):
            return jsonify({'error': 'Authentication required.'}), 401
        try:
            request.user = jwt.decode(header.split(' ')[1], JWT_SECRET, algorithms=['HS256'])
        except jwt.InvalidTokenError:
            return jsonify({'error': 'Invalid or expired token.'}), 401
        return f(*args, **kwargs)
    return decorated


# ── Auth ───────────────────────────────────────────────────────────────────────

@app.post('/api/auth/register')
def register():
    data = request.get_json()
    email    = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''

    if not EMAIL_RE.match(email):
        return jsonify({'error': 'A valid email address is required.'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters.'}), 400

    existing = supabase.table('users').select('id').eq('email', email).limit(1).execute()
    if existing.data:
        return jsonify({'error': 'An account with this email already exists.'}), 409

    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    user_id = 'USR' + str(int(datetime.now(timezone.utc).timestamp() * 1000))
    user = {'id': user_id, 'email': email, 'password_hash': password_hash}

    result = supabase.table('users').insert(user).execute()
    if not result.data:
        return jsonify({'error': 'Failed to create account.'}), 500

    token = _make_token(user_id, email)
    print(f'[register] {email}')
    return jsonify({'token': token, 'user': {'id': user_id, 'email': email}}), 201


@app.post('/api/auth/login')
def login():
    data = request.get_json()
    email    = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''

    if not email or not password:
        return jsonify({'error': 'Email and password are required.'}), 400

    result = supabase.table('users').select('*').eq('email', email).limit(1).execute()
    user = result.data[0] if result.data else None

    if not user or not bcrypt.checkpw(password.encode(), user['password_hash'].encode()):
        return jsonify({'error': 'Incorrect email or password.'}), 401

    token = _make_token(user['id'], user['email'])
    print(f'[login] {email}')
    return jsonify({'token': token, 'user': {'id': user['id'], 'email': user['email']}})


@app.get('/api/auth/me')
@require_auth
def me():
    return jsonify({'id': request.user['id'], 'email': request.user['email']})


# ── Signups (waitlist) ─────────────────────────────────────────────────────────

@app.post('/api/signups')
def add_signup():
    data  = request.get_json()
    email = (data.get('email') or '').strip().lower()

    if not EMAIL_RE.match(email):
        return jsonify({'error': 'A valid email address is required.'}), 400

    existing = supabase.table('signups').select('id').eq('email', email).limit(1).execute()
    if existing.data:
        return jsonify({'message': "Already registered — you're on the list!"}), 200

    result = supabase.table('signups').insert({
        'email': email,
        'source': request.referrer or 'direct',
    }).execute()

    if not result.data:
        return jsonify({'error': 'Failed to save signup.'}), 500

    print(f'[signup] {email}')
    return jsonify({'message': 'Signup successful'}), 201


@app.get('/api/admin/signups')
def admin_signups():
    result = supabase.table('signups').select('*').order('created_at', desc=True).execute()
    signups = result.data or []
    return jsonify({'count': len(signups), 'signups': signups})


# ── Business profile ───────────────────────────────────────────────────────────

@app.get('/api/business')
@require_auth
def get_business():
    result = supabase.table('businesses').select('*').eq('user_id', request.user['id']).limit(1).execute()
    if not result.data:
        return jsonify({'error': 'No business profile found.'}), 404
    return jsonify(result.data[0])


@app.post('/api/business')
@require_auth
def save_business():
    data  = request.get_json()
    name  = data.get('name')
    type_ = data.get('type')

    if not name or not type_:
        return jsonify({'error': 'Name and type are required.'}), 400

    record = {
        'id':        'BIZ' + request.user['id'],
        'user_id':   request.user['id'],
        'name':      name,
        'type':      type_,
        'employees': data.get('employees', []),
        'tasks':     data.get('tasks', []),
        'budget':    data.get('budget', 25000),
    }

    supabase.table('businesses').upsert(record).execute()
    print(f"[business saved] {request.user['email']} — {name}")
    return jsonify(record), 201


# ── Sessions ───────────────────────────────────────────────────────────────────

@app.post('/api/sessions')
@require_auth
def save_session():
    data       = request.get_json()
    session_id = data.get('sessionId')

    if not session_id:
        return jsonify({'error': 'sessionId is required.'}), 400

    actions = data.get('actions', [])
    record = {
        'id':           session_id,
        'user_id':      request.user['id'],
        'user_email':   request.user['email'],
        'start_time':   data.get('startTime'),
        'action_count': len(actions) if isinstance(actions, list) else 0,
        'actions':      actions,
        'final_state':  data.get('finalState', {}),
    }

    supabase.table('sessions').upsert(record).execute()
    print(f"[session saved] {request.user['email']} — {session_id}")
    return jsonify({'message': 'Session saved', 'id': session_id}), 201


@app.get('/api/sessions')
@require_auth
def get_sessions():
    result = (
        supabase.table('sessions')
        .select('id, start_time, saved_at, action_count, final_state')
        .eq('user_id', request.user['id'])
        .order('saved_at', desc=True)
        .execute()
    )
    return jsonify(result.data or [])


@app.get('/api/sessions/<session_id>')
@require_auth
def get_session(session_id):
    result = (
        supabase.table('sessions')
        .select('*')
        .eq('id', session_id)
        .eq('user_id', request.user['id'])
        .limit(1)
        .execute()
    )
    if not result.data:
        return jsonify({'error': 'Session not found.'}), 404
    return jsonify(result.data[0])


@app.delete('/api/sessions/<session_id>')
@require_auth
def delete_session(session_id):
    supabase.table('sessions').delete().eq('id', session_id).eq('user_id', request.user['id']).execute()
    return jsonify({'message': 'Session deleted'})


# ── Static files ───────────────────────────────────────────────────────────────

@app.get('/')
def serve_index():
    return send_from_directory(BASE_DIR, 'index.html')

@app.get('/<path:filename>')
def serve_static(filename):
    return send_from_directory(BASE_DIR, filename)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _make_token(user_id, email):
    return jwt.encode(
        {'id': user_id, 'email': email, 'exp': datetime.now(timezone.utc) + timedelta(days=30)},
        JWT_SECRET,
        algorithm='HS256',
    )


# ── Start ──────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print(f'\nPolaris backend running at http://localhost:{PORT}\n')
    app.run(port=PORT, debug=True, use_reloader=False)
