import hashlib
import time
import os
import json
import base64
import re
import secrets
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from dotenv import load_dotenv
from openai import OpenAI                                   # === NEW ===

load_dotenv()

app = FastAPI(title="AgriPack AI Backend")

BASE = Path(__file__).parent
DB_PATH = BASE / "agri.db"
UPLOADS = BASE / "uploads"
UPLOADS.mkdir(exist_ok=True)
FRONTEND = BASE.parent / "frontend"

ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")  # set a real one before deploying
THRESHOLD_KG = 50
MAX_PHOTO = 5 * 1024 * 1024
EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
CATEGORIES = {"cassava", "maize", "banana", "sugarcane"}

# === NEW: Groq client (uses the OpenAI-compatible endpoint) ===
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
groq = OpenAI(api_key=GROQ_API_KEY, base_url="https://api.groq.com/openai/v1") if GROQ_API_KEY else None
AI_MODEL = "openai/gpt-oss-120b"
# === END NEW ===

SCHEMA = """
CREATE TABLE IF NOT EXISTS farmers(id TEXT PRIMARY KEY, name TEXT, loc TEXT, created TEXT,
                                   username TEXT, pw_hash TEXT, salt TEXT);
CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE,
                                     pw_hash TEXT, salt TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, role TEXT, user_id TEXT);
CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY, farmer_id TEXT, cat TEXT, descr TEXT,
                                       weight REAL, photo TEXT, status TEXT, ai_note TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, customer_id TEXT, cat TEXT, qty INTEGER,
                                    status TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS ai_actions(id TEXT PRIMARY KEY, actor TEXT, action TEXT, target TEXT,
                                      detail TEXT, created TEXT);
"""


# Initialize the Groq client using the OpenAI SDK format
client = OpenAI(
    api_key=os.getenv("GROQ_API_KEY"),
    base_url="https://api.groq.com/openai/v1"
)

def encode_image(image_bytes: bytes) -> str:
    return base64.b64encode(image_bytes).decode('utf-8')


def init_db():
    con = sqlite3.connect(DB_PATH)
    con.executescript(SCHEMA)
    have = {row[1] for row in con.execute("PRAGMA table_info(farmers)")}
    for col in ("username", "pw_hash", "salt"):
        if col not in have:
            con.execute(f"ALTER TABLE farmers ADD COLUMN {col} TEXT")
    con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_farmers_username ON farmers(username)")
    con.commit()
    con.close()


USERNAME_RE = re.compile(r"^[a-z0-9_]{3,20}$")

init_db()
app = FastAPI(title="EcoLoop API")


@app.middleware("http")
async def no_cache(request, call_next):
    t0 = time.time()
    is_upload = request.method == "POST" and request.url.path == "/api/submissions"
    if is_upload:
        print(f"[upload] 1/4 request arrived, content-length={request.headers.get('content-length')}", flush=True)
    resp = await call_next(request)
    if is_upload:
        print(f"[upload] 4/4 finished with {resp.status_code} after {time.time() - t0:.2f}s", flush=True)
    if not request.url.path.startswith(("/api", "/uploads")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# ---------- helpers ----------
def db():
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    try:
        yield con
    finally:
        con.close()


def now():
    return datetime.now(timezone.utc).isoformat()


def new_id():
    return uuid.uuid4().hex[:8]


def hash_pw(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 120_000).hex()


def new_token(con, role: str, user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    con.execute("INSERT INTO tokens VALUES(?,?,?)", (token, role, user_id))
    con.commit()
    return token


def auth(role: str):
    def dep(authorization: Optional[str] = Header(None), con=Depends(db)):
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "Not signed in")
        row = con.execute("SELECT * FROM tokens WHERE token=?", (authorization[7:],)).fetchone()
        if not row or row["role"] != role:
            raise HTTPException(401, "Invalid session")
        return row["user_id"]
    return dep


def ai_check(weight: float, desc: str, has_photo: bool):
    """Rule-based stand-in. This is the one function to replace with a vision model later."""
    problems = []
    if weight < THRESHOLD_KG:
        problems.append(f"weight {weight:g} kg is below {THRESHOLD_KG} kg")
    if len(desc) < 20:
        problems.append("description is too short")
    if not has_photo:
        problems.append("no photo attached")
    if problems:
        return "review", "Needs review: " + "; ".join(problems)
    return "flagged", f"Meets threshold ({weight:g} kg, description and photo provided)"


# === NEW: AI triage that wraps ai_check with Groq reasoning ===
def ai_triage(weight: float, desc: str, has_photo: bool):
    """
    Returns (status, note). Falls back to the rule-based ai_check if Groq
    is not configured or fails, so the app never breaks because of the AI.
    """
    rule_status, rule_note = ai_check(weight, desc, has_photo)

    if not groq:
        return rule_status, rule_note

    prompt = (
        "You are the admin assistant for EcoLoop, a farm-waste recycling platform.\n"
        f"Submission: weight={weight}kg, has_photo={has_photo}, description=\"{desc}\"\n"
        f"Rule engine says: {rule_note}\n\n"
        "Decide one of: approved, rejected, review, flagged.\n"
        "Rules:\n"
        "- flagged   : meets all rules, ready for admin to approve.\n"
        "- rejected  : obviously fake (weight<=0, gibberish desc, no photo AND short desc).\n"
        "- review    : anything uncertain (borderline weight, vague desc, no photo).\n"
        "Reply ONLY as JSON: {\"status\":\"...\",\"note\":\"one short sentence\"}"
    )

    try:
        import json as _json
        r = groq.chat.completions.create(
            model=AI_MODEL,
            messages=[{"role": "user", "content": prompt}],
            reasoning_effort="low",
            max_completion_tokens=400,
            temperature=0.2,
        )
        content = (r.choices[0].message.content or "").strip()
        # Model may wrap JSON in ```json ... ``` fences
        if content.startswith("```"):
            content = content.split("```")[1]
            if content.startswith("json"):
                content = content[4:]
        data = _json.loads(content.strip())
        status = data.get("status", rule_status)
        note = data.get("note", rule_note)
        if status not in ("approved", "rejected", "review", "flagged"):
            status = rule_status
        return status, note
    except Exception as e:
        print(f"[ai] triage failed, falling back to rules: {e}", flush=True)
        return rule_status, rule_note
# === END NEW ===


SUB_SQL = ("SELECT s.*, f.name AS farmer, f.loc AS loc "
           "FROM submissions s JOIN farmers f ON f.id = s.farmer_id")
REQ_SQL = ("SELECT r.*, c.name AS customer, c.email AS email "
           "FROM requests r JOIN customers c ON c.id = r.customer_id")


def sub_out(r):
    return {"id": r["id"], "farmerId": r["farmer_id"], "farmer": r["farmer"], "loc": r["loc"],
            "cat": r["cat"], "desc": r["descr"], "weight": r["weight"], "photo": r["photo"],
            "status": r["status"], "aiNote": r["ai_note"], "date": r["created"][:10]}


def req_out(r):
    return {"id": r["id"], "customerId": r["customer_id"], "customer": r["customer"],
            "email": r["email"], "cat": r["cat"], "qty": r["qty"], "status": r["status"],
            "date": r["created"][:10]}


# ---------- request bodies ----------
class FarmerIn(BaseModel):
    name: str
    loc: str
    username: str
    password: str


class FarmerLoginIn(BaseModel):
    username: str
    password: str


class CustomerIn(BaseModel):
    name: str
    email: str
    password: str


class LoginIn(BaseModel):
    email: str
    password: str


class AdminIn(BaseModel):
    password: str


class RequestIn(BaseModel):
    cat: str
    qty: int


class StatusIn(BaseModel):
    status: str


# === NEW: request body for the AI chat endpoint ===
class ChatIn(BaseModel):
    message: str
# === END NEW ===



@app.post("/api/v1/analyze-freshness")
async def analyze_freshness(file: UploadFile = File(...)):
    if not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Invalid file type. Please upload an image.")
    
    # Read and encode the uploaded image
    contents = await file.read()
    base64_image = encode_image(contents)
    
    # The engineered heuristic prompt replacing custom CNN training
    system_prompt = """
    You are an expert agricultural freshness analyzer. You are evaluating a red cabbage anthocyanin pH sensor attached to food packaging. 
    Analyze the dominant color of the sensor in the provided image based on this strict heuristic scale:
    
    - Deep Purple to Blue-Violet: Neutral pH (~6-7). Status: FRESH.
    - Pink to Red: Acidic pH (< 5). Status: FRUIT ROT / FERMENTATION.
    - Blue to Sea Green: Alkaline pH (> 8). Status: BACTERIAL DECAY (Cooked Food).
    
    Respond strictly with a raw JSON object (no markdown, no backticks) containing the following keys:
    "color_detected" (string),
    "estimated_ph_state" (string),
    "freshness_percentage" (integer 0-100),
    "status" (string: "FRESH", "WARNING", or "SPOILED"),
    "action_required" (string: specific logistical instruction).
    """

    try:
        # Pass the image to the Vision Language Model
        response = client.chat.completions.create(
            model="qwen/qwen3.8-27b",  # Or whichever vision model you have provisioned on Groq
            messages=[
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Analyze this AgriPack sensor and return the JSON assessment."},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{file.content_type};base64,{base64_image}"
                            }
                        }
                    ]
                }
            ],
            temperature=0.1,  # Keep temperature low for consistent JSON output
            max_tokens=300,
        )
        
        # Parse the string response into a JSON object
        raw_output = response.choices[0].message.content.strip()
        
        # Strip markdown formatting if the model disobeys the prompt
        if raw_output.startswith("```json"):
            raw_output = raw_output[7:-3]
            
        return json.loads(raw_output)

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------- farmers ----------
@app.post("/api/farmers/register")
def farmer_register(body: FarmerIn, con=Depends(db)):
    name, loc = body.name.strip(), body.loc.strip()
    username = body.username.strip().lower()
    if not name or not loc:
        raise HTTPException(400, "Name and location are required")
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "Username must be 3 to 20 letters, numbers or underscores")
    if len(body.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    fid, salt = new_id(), secrets.token_hex(16)
    try:
        con.execute("INSERT INTO farmers(id, name, loc, created, username, pw_hash, salt) VALUES(?,?,?,?,?,?,?)",
                    (fid, name, loc, now(), username, hash_pw(body.password, salt), salt))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "That username is taken. Choose another, or sign in if it is yours")
    token = new_token(con, "farmer", fid)
    return {"token": token, "profile": {"id": fid, "name": name, "loc": loc, "username": username}}


@app.post("/api/farmers/login")
def farmer_login(body: FarmerLoginIn, con=Depends(db)):
    row = con.execute("SELECT * FROM farmers WHERE username=?", (body.username.strip().lower(),)).fetchone()
    if not row or not secrets.compare_digest(row["pw_hash"], hash_pw(body.password, row["salt"])):
        raise HTTPException(401, "Wrong username or password")
    token = new_token(con, "farmer", row["id"])
    return {"token": token, "profile": {"id": row["id"], "name": row["name"], "loc": row["loc"],
                                         "username": row["username"]}}


@app.post("/api/logout")
def logout(authorization: Optional[str] = Header(None), con=Depends(db)):
    if authorization and authorization.startswith("Bearer "):
        con.execute("DELETE FROM tokens WHERE token=?", (authorization[7:],))
        con.commit()
    return {"ok": True}


@app.post("/api/submissions")
def create_submission(
    cat: str = Form(...),
    desc: str = Form(...),
    weight: float = Form(...),
    photo: Optional[UploadFile] = File(None),
    farmer_id: str = Depends(auth("farmer")),
    con=Depends(db),
):
    print("[upload] 2/4 form parsed, handler running", flush=True)
    desc = desc.strip()
    if cat not in CATEGORIES:
        raise HTTPException(400, "Unknown waste category")
    if not desc or not (0 < weight <= 100000):
        raise HTTPException(400, "Add a description and a valid weight")

    photo_url = None
    if photo and photo.filename:
        ext = EXT.get(photo.content_type)
        if not ext:
            raise HTTPException(400, "Photo must be a JPG, PNG or WebP image")
        data = photo.file.read(MAX_PHOTO + 1)
        if len(data) > MAX_PHOTO:
            raise HTTPException(400, "Photo is too large (max 5 MB)")
        name = uuid.uuid4().hex + ext
        (UPLOADS / name).write_bytes(data)
        print(f"[upload] 3/4 photo saved ({len(data)} bytes)", flush=True)
        photo_url = f"/uploads/{name}"

    # === CHANGED: was ai_check(weight, desc, photo_url is not None) ===
    status, note = ai_triage(weight, desc, photo_url is not None)
    # === END CHANGE ===

    sid = new_id()
    con.execute("INSERT INTO submissions VALUES(?,?,?,?,?,?,?,?,?)",
                (sid, farmer_id, cat, desc, weight, photo_url, status, note, now()))
    con.commit()
    return sub_out(con.execute(SUB_SQL + " WHERE s.id=?", (sid,)).fetchone())


@app.get("/api/submissions/mine")
def my_submissions(farmer_id: str = Depends(auth("farmer")), con=Depends(db)):
    rows = con.execute(SUB_SQL + " WHERE s.farmer_id=? ORDER BY s.created DESC", (farmer_id,)).fetchall()
    return [sub_out(r) for r in rows]


# ---------- customers ----------
@app.post("/api/customers/register")
def customer_register(body: CustomerIn, con=Depends(db)):
    name, email = body.name.strip(), body.email.strip().lower()
    if not name or "@" not in email or len(body.password) < 6:
        raise HTTPException(400, "Enter a name, a valid email and a password of 6+ characters")
    cid, salt = new_id(), secrets.token_hex(16)
    try:
        con.execute("INSERT INTO customers VALUES(?,?,?,?,?,?)",
                    (cid, name, email, hash_pw(body.password, salt), salt, now()))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "That email is already registered, try signing in")
    token = new_token(con, "customer", cid)
    return {"token": token, "profile": {"id": cid, "name": name, "email": email}}


@app.post("/api/customers/login")
def customer_login(body: LoginIn, con=Depends(db)):
    row = con.execute("SELECT * FROM customers WHERE email=?", (body.email.strip().lower(),)).fetchone()
    if not row or not secrets.compare_digest(row["pw_hash"], hash_pw(body.password, row["salt"])):
        raise HTTPException(401, "Wrong email or password")
    token = new_token(con, "customer", row["id"])
    return {"token": token, "profile": {"id": row["id"], "name": row["name"], "email": row["email"]}}


@app.post("/api/requests")
def create_request(body: RequestIn, customer_id: str = Depends(auth("customer")), con=Depends(db)):
    if body.cat not in CATEGORIES or not (1 <= body.qty <= 100000):
        raise HTTPException(400, "Choose a valid package and quantity")
    rid = new_id()
    con.execute("INSERT INTO requests VALUES(?,?,?,?,?,?)",
                (rid, customer_id, body.cat, body.qty, "requested", now()))
    con.commit()
    return req_out(con.execute(REQ_SQL + " WHERE r.id=?", (rid,)).fetchone())


@app.get("/api/requests/mine")
def my_requests(customer_id: str = Depends(auth("customer")), con=Depends(db)):
    rows = con.execute(REQ_SQL + " WHERE r.customer_id=? ORDER BY r.created DESC", (customer_id,)).fetchall()
    return [req_out(r) for r in rows]


@app.post("/api/requests/{rid}/pay")
def pay_request(rid: str, customer_id: str = Depends(auth("customer")), con=Depends(db)):
    r = con.execute("SELECT * FROM requests WHERE id=? AND customer_id=?", (rid, customer_id)).fetchone()
    if not r:
        raise HTTPException(404, "Request not found")
    if r["status"] != "payment_requested":
        raise HTTPException(400, "Payment has not been requested for this order")
    con.execute("UPDATE requests SET status='paid' WHERE id=?", (rid,))
    con.commit()
    return {"ok": True}


# ---------- admin ----------
@app.post("/api/admin/login")
def admin_login(body: AdminIn, con=Depends(db)):
    if not secrets.compare_digest(body.password.encode(), ADMIN_PASSWORD.encode()):
        raise HTTPException(401, "Wrong password")
    return {"token": new_token(con, "admin", "admin")}


@app.get("/api/submissions")
def all_submissions(_admin=Depends(auth("admin")), con=Depends(db)):
    return [sub_out(r) for r in con.execute(SUB_SQL + " ORDER BY s.created DESC").fetchall()]


@app.patch("/api/submissions/{sid}")
def review_submission(sid: str, body: StatusIn, _admin=Depends(auth("admin")), con=Depends(db)):
    r = con.execute("SELECT status FROM submissions WHERE id=?", (sid,)).fetchone()
    if not r:
        raise HTTPException(404, "Submission not found")
    if body.status not in ("approved", "rejected") or r["status"] not in ("flagged", "review"):
        raise HTTPException(400, "That change isn't allowed")
    con.execute("UPDATE submissions SET status=? WHERE id=?", (body.status, sid))
    con.commit()
    return {"ok": True}


@app.get("/api/requests")
def all_requests(_admin=Depends(auth("admin")), con=Depends(db)):
    return [req_out(r) for r in con.execute(REQ_SQL + " ORDER BY r.created DESC").fetchall()]


NEXT_STEP = {"requested": "payment_requested", "paid": "delivered"}


@app.patch("/api/requests/{rid}")
def advance_request(rid: str, body: StatusIn, _admin=Depends(auth("admin")), con=Depends(db)):
    r = con.execute("SELECT status FROM requests WHERE id=?", (rid,)).fetchone()
    if not r:
        raise HTTPException(404, "Request not found")
    if NEXT_STEP.get(r["status"]) != body.status:
        raise HTTPException(400, f"Can't move from {r['status']} to {body.status}")
    con.execute("UPDATE requests SET status=? WHERE id=?", (body.status, rid))
    con.commit()
    return {"ok": True}


# === NEW: AI admin agent (tools + chat + batch auto-review) ===
import json as _json


def _admin_con():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def tool_count_submissions(status: Optional[str] = None) -> str:
    con = _admin_con()
    try:
        if status:
            n = con.execute("SELECT COUNT(*) FROM submissions WHERE status=?", (status,)).fetchone()[0]
        else:
            n = con.execute("SELECT COUNT(*) FROM submissions").fetchone()[0]
        return _json.dumps({"count": n, "status": status or "all"})
    finally:
        con.close()


def tool_top_farmers(limit: int = 5) -> str:
    con = _admin_con()
    try:
        rows = con.execute(
            "SELECT f.name, COUNT(*) AS n FROM submissions s "
            "JOIN farmers f ON f.id = s.farmer_id "
            "GROUP BY f.id ORDER BY n DESC LIMIT ?", (limit,)
        ).fetchall()
        return _json.dumps([{"farmer": r["name"], "submissions": r["n"]} for r in rows])
    finally:
        con.close()


def tool_pending_requests() -> str:
    con = _admin_con()
    try:
        rows = con.execute(
            "SELECT r.id, c.name AS customer, r.cat, r.qty, r.status "
            "FROM requests r JOIN customers c ON c.id = r.customer_id "
            "WHERE r.status IN ('requested','payment_requested','paid')"
        ).fetchall()
        return _json.dumps([dict(r) for r in rows])
    finally:
        con.close()


def tool_auto_advance(rid: str) -> str:
    con = _admin_con()
    try:
        r = con.execute("SELECT status FROM requests WHERE id=?", (rid,)).fetchone()
        if not r:
            return _json.dumps({"error": "not found"})
        nxt = NEXT_STEP.get(r["status"])
        if not nxt:
            return _json.dumps({"error": f"no next step from {r['status']}"})
        con.execute("UPDATE requests SET status=? WHERE id=?", (nxt, rid))
        con.commit()
        return _json.dumps({"id": rid, "from": r["status"], "to": nxt})
    finally:
        con.close()

def _log_action(action: str, target: str, detail: str = "") -> None:
    """Write an entry to ai_actions. Never raises."""
    try:
        con = _admin_con()
        try:
            con.execute(
                "INSERT INTO ai_actions VALUES(?,?,?,?,?,?)",
                (new_id(), "admin", action, target, detail, now()),
            )
            con.commit()
        finally:
            con.close()
    except Exception as e:
        print(f"[ai] audit log failed: {e}", flush=True)


def tool_approve_submission(sid: str, reason: str = "") -> str:
    """Admin-only: mark a flagged/review submission as approved. Logs the action."""
    con = _admin_con()
    try:
        r = con.execute("SELECT status FROM submissions WHERE id=?", (sid,)).fetchone()
        if not r:
            return _json.dumps({"error": f"submission {sid} not found"})
        if r["status"] not in ("flagged", "review"):
            return _json.dumps({"error": f"submission {sid} is '{r['status']}', can't approve"})
        note = f"AI-approved. {reason}".strip() if reason else "AI-approved."
        con.execute("UPDATE submissions SET status='approved', ai_note=? WHERE id=?", (note, sid))
        con.commit()
        _log_action("approve_submission", sid, reason)
        return _json.dumps({"ok": True, "id": sid, "new_status": "approved"})
    finally:
        con.close()


def tool_reject_submission(sid: str, reason: str = "") -> str:
    """Admin-only: mark a flagged/review submission as rejected. Logs the action."""
    con = _admin_con()
    try:
        r = con.execute("SELECT status FROM submissions WHERE id=?", (sid,)).fetchone()
        if not r:
            return _json.dumps({"error": f"submission {sid} not found"})
        if r["status"] not in ("flagged", "review"):
            return _json.dumps({"error": f"submission {sid} is '{r['status']}', can't reject"})
        note = f"AI-rejected. {reason}".strip() if reason else "AI-rejected."
        con.execute("UPDATE submissions SET status='rejected', ai_note=? WHERE id=?", (note, sid))
        con.commit()
        _log_action("reject_submission", sid, reason)
        return _json.dumps({"ok": True, "id": sid, "new_status": "rejected"})
    finally:
        con.close()


def tool_find_submission(query: str) -> str:
    """
    Admin-only helper: find submissions by farmer name, category, description, or partial ID.
    Matches ANY word in the query (so 'Test Farmer maize' works).
    """
    con = _admin_con()
    try:
        words = [w for w in query.strip().split() if len(w) >= 2]
        if not words:
            return _json.dumps([])

        # Build: (id LIKE ? OR farmer LIKE ? OR cat LIKE ? OR descr LIKE ?) AND (...) AND (...)
        clauses = []
        params = []
        for w in words:
            clauses.append("(s.id LIKE ? OR f.name LIKE ? OR s.cat LIKE ? OR s.descr LIKE ?)")
            like = f"%{w}%"
            params.extend([like, like, like, like])

        sql = (
            "SELECT s.id, s.cat, s.descr, s.weight, s.status, f.name AS farmer "
            "FROM submissions s JOIN farmers f ON f.id = s.farmer_id "
            "WHERE " + " AND ".join(clauses) + " "
            "ORDER BY s.created DESC LIMIT 10"
        )
        rows = con.execute(sql, params).fetchall()
        return _json.dumps([dict(r) for r in rows])
    finally:
        con.close()

ADMIN_TOOLS = [
    {"type": "function", "function": {
        "name": "count_submissions",
        "description": "Count submissions, optionally filtered by status (flagged, review, approved, rejected).",
        "parameters": {"type": "object", "properties": {
            "status": {"type": "string", "description": "Optional status filter."}},
            "required": []}}},
    {"type": "function", "function": {
        "name": "top_farmers",
        "description": "List farmers with the most submissions.",
        "parameters": {"type": "object", "properties": {
            "limit": {"type": "integer", "description": "How many to return, default 5."}},
            "required": []}}},
    {"type": "function", "function": {
        "name": "pending_requests",
        "description": "List customer requests that are not yet delivered.",
        "parameters": {"type": "object", "properties": {}, "required": []}}},
    {"type": "function", "function": {
        "name": "auto_advance",
        "description": "Advance a request to its next status (requested->payment_requested, paid->delivered).",
        "parameters": {"type": "object", "properties": {
            "rid": {"type": "string", "description": "Request ID."}},
            "required": ["rid"]}}},
    {"type": "function", "function": {
        "name": "find_submission",
        "description": "Find submissions by farmer name, category, description keyword, or partial ID. Use this BEFORE approve/reject when you don't already have the exact submission ID.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "Free-text search: farmer name, category (cassava/maize/banana/sugarcane), description keyword, or submission ID prefix."}},
            "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "approve_submission",
        "description": "Approve a submission that is currently 'flagged' or 'review'. Only use when the admin clearly asks you to approve.",
        "parameters": {"type": "object", "properties": {
            "sid": {"type": "string", "description": "Submission ID."},
            "reason": {"type": "string", "description": "One short sentence explaining the decision."}},
            "required": ["sid"]}}},
    {"type": "function", "function": {
        "name": "reject_submission",
        "description": "Reject a submission that is currently 'flagged' or 'review'. Only use when the admin clearly asks you to reject.",
        "parameters": {"type": "object", "properties": {
            "sid": {"type": "string", "description": "Submission ID."},
            "reason": {"type": "string", "description": "One short sentence explaining the decision."}},
            "required": ["sid"]}}},
]

TOOL_FUNCS = {
    "count_submissions": tool_count_submissions,
    "top_farmers": tool_top_farmers,
    "pending_requests": tool_pending_requests,
    "auto_advance": tool_auto_advance,
    "find_submission": tool_find_submission,
    "approve_submission": tool_approve_submission,
    "reject_submission": tool_reject_submission,
}


@app.post("/api/admin/ai/chat")
def admin_ai_chat(body: ChatIn, _admin=Depends(auth("admin"))):
    """Admin talks to the AI; AI can query the DB and act on submissions/orders via tools."""
    if not groq:
        raise HTTPException(503, "AI not configured (set GROQ_API_KEY in backend/.env)")

    messages = [
        {"role": "system", "content":
            "You are the EcoLoop admin assistant. Use the provided tools to answer "
            "questions about farmers, submissions and customer requests.\n"
            "\n"
            "WORKFLOW FOR ACTIONS:\n"
            "- When the admin asks you to approve or reject a submission, FIRST call "
            "find_submission. Pass a SHORT query using only the most distinctive words "
            "(usually a farmer name OR a category, not both joined together). "
            "Only proceed if exactly one result matches.\n"
            "- If zero matches: tell the admin and stop.\n"
            "- If multiple matches: list them briefly (ID, farmer, category) and ask "
            "which one they mean. Do NOT guess.\n"
            "- Then call approve_submission or reject_submission. You MUST use the "
            "exact parameter name 'sid' (not sub_id, not id) for the submission ID, "
            "and 'reason' for the explanation.\n"
            "- After acting, reply with a short confirmation naming the submission ID "
            "and the farmer. Example: 'Approved submission a1b2c3d4 from Test Farmer.'\n"
            "\n"
            "RULES:\n"
            "- Never approve or reject unless the admin clearly asked for it.\n"
            "- Never invent submission IDs. Always get them via find_submission.\n"
            "- Only call auto_advance when the admin clearly asks to advance a request.\n"
            "- Reply in plain text only — no Markdown, no asterisks, no bullet symbols, "
            "no code fences. Keep replies to 1-3 short sentences unless asked for more."},
        {"role": "user", "content": body.message},
    ]

    actions = []

    # Tool-calling loop: keep going until the model stops asking for tools.
    # Cap at 6 rounds so a buggy model can't loop forever.
    for _round in range(6):
        resp = groq.chat.completions.create(
            model=AI_MODEL,
            messages=messages,
            tools=ADMIN_TOOLS,
            tool_choice="auto",
        )
        msg = resp.choices[0].message
        messages.append(msg)

        if not msg.tool_calls:
            return {"reply": msg.content or "(no response)", "actions": actions}

        for call in msg.tool_calls:
            fn = TOOL_FUNCS.get(call.function.name)
            try:
                args = _json.loads(call.function.arguments or "{}")
            except Exception:
                args = {}

            # Normalize common aliases Groq's reasoning models invent
            if "sid" not in args:
                for alt in ("sub_id", "submission_id", "id"):
                    if alt in args:
                        args["sid"] = args.pop(alt)
                        break
            if "rid" not in args:
                for alt in ("request_id", "order_id", "id"):
                    if alt in args:
                        args["rid"] = args.pop(alt)
                        break

            try:
                result = fn(**args) if fn else _json.dumps({"error": "unknown tool"})
            except TypeError as e:
                # Bad argument names from the model — return an error the AI can learn from
                result = _json.dumps({"error": f"bad arguments for {call.function.name}: {e}"})
            except Exception as e:
                result = _json.dumps({"error": f"{call.function.name} crashed: {e}"})

            if call.function.name in ("approve_submission", "reject_submission", "auto_advance"):
                try:
                    parsed = _json.loads(result)
                except Exception:
                    parsed = {}
                actions.append({
                    "tool": call.function.name,
                    "args": args,
                    "ok": bool(parsed.get("ok")),
                    "result": parsed,
                })

            messages.append({
                "role": "tool",
                "tool_call_id": call.id,
                "name": call.function.name,
                "content": result,
            })

    return {"reply": "I hit my step limit while trying to complete that. Try a more specific request.", "actions": actions}


@app.post("/api/admin/ai/auto-review")
def ai_auto_review(_admin=Depends(auth("admin")), con=Depends(db)):
    """AI re-evaluates every 'review' submission and approves/rejects what it can."""
    if not groq:
        raise HTTPException(503, "AI not configured (set GROQ_API_KEY in backend/.env)")

    rows = con.execute("SELECT * FROM submissions WHERE status='review'").fetchall()
    changed = 0
    for r in rows:
        status, note = ai_triage(r["weight"], r["descr"], r["photo"] is not None)
        if status in ("approved", "rejected"):
            con.execute("UPDATE submissions SET status=?, ai_note=? WHERE id=?",
                        (status, note, r["id"]))
            changed += 1
    con.commit()
    return {"reviewed": len(rows), "auto_decided": changed}
# === END NEW ===


# ---------- static files (must come last) ----------
app.mount("/uploads", StaticFiles(directory=UPLOADS), name="uploads")
app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")