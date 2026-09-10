import os
import sqlite3
from datetime import datetime
from functools import wraps

from flask import Flask, abort, current_app, flash, g, redirect, render_template_string, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student', 'teacher'))
);
CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    activity_time TEXT NOT NULL,
    location TEXT NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    deadline TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'cancelled')),
    teacher_id INTEGER NOT NULL REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    activity_id INTEGER NOT NULL REFERENCES activities(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, activity_id)
);
"""

BASE = """
<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>
<link href='https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css' rel='stylesheet'>
<title>校园活动管理系统</title></head><body class='bg-light'>
<nav class='navbar navbar-dark bg-primary mb-4'><div class='container'><a class='navbar-brand' href='{{ url_for("index") }}'>校园活动管理系统</a><div>
{% if session.get('user_id') %}<a class='text-white me-3' href='{{ url_for("my_registrations") }}'>我的报名</a>{% if session.get('role') == 'teacher' %}<a class='text-white me-3' href='{{ url_for("teacher_activities") }}'>教师管理</a>{% endif %}<a class='text-white' href='{{ url_for("logout") }}'>退出</a>{% else %}<a class='text-white me-3' href='{{ url_for("login") }}'>登录</a><a class='text-white' href='{{ url_for("register") }}'>注册</a>{% endif %}
</div></div></nav><main class='container'>{% for message in get_flashed_messages() %}<div class='alert alert-info'>{{ message }}</div>{% endfor %}{{ body|safe }}</main></body></html>
"""


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
    return g.db


def close_db(_error=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def page(body, **context):
    return render_template_string(BASE, body=render_template_string(body, **context))


def role_required(role):
    def decorator(view):
        @wraps(view)
        def wrapped(*args, **kwargs):
            if session.get("role") != role:
                flash("无权访问该功能")
                return redirect(url_for("index"))
            return view(*args, **kwargs)
        return wrapped
    return decorator


def create_app(test_config=None):
    app = Flask(__name__)
    app.config.from_mapping(
        SECRET_KEY=os.environ.get("SECRET_KEY", "campus-activity-demo"),
        DATABASE=os.path.join(app.instance_path, "campus.db"),
    )
    if test_config:
        app.config.update(test_config)
    os.makedirs(app.instance_path, exist_ok=True)
    with app.app_context():
        get_db().executescript(SCHEMA)
        get_db().commit()
    app.teardown_appcontext(close_db)

    @app.route("/")
    def index():
        activities = get_db().execute("SELECT a.*, u.username teacher FROM activities a JOIN users u ON u.id=a.teacher_id WHERE status='published' ORDER BY activity_time").fetchall()
        return page("""<div class='d-flex justify-content-between align-items-center'><h1 class='h3'>可报名活动</h1></div><div class='row'>{% for a in activities %}<div class='col-md-6 mb-3'><div class='card'><div class='card-body'><h2 class='h5'>{{ a.title }}</h2><p class='mb-1'>时间：{{ a.activity_time }}</p><p class='mb-1'>地点：{{ a.location }}</p><a class='btn btn-outline-primary btn-sm' href='{{ url_for("activity_detail", activity_id=a.id) }}'>查看详情</a></div></div></div>{% else %}<p>暂无已发布活动。</p>{% endfor %}</div>""", activities=activities)

    @app.route("/register", methods=["GET", "POST"])
    def register():
        if request.method == "POST":
            username, password, role = request.form.get("username", "").strip(), request.form.get("password", ""), request.form.get("role")
            if not username or not password or role not in {"student", "teacher"}:
                flash("请完整填写注册信息")
            else:
                try:
                    get_db().execute("INSERT INTO users (username,password_hash,role) VALUES (?,?,?)", (username, generate_password_hash(password), role))
                    get_db().commit(); flash("注册成功，请登录"); return redirect(url_for("login"))
                except sqlite3.IntegrityError:
                    flash("用户名已存在")
        return page("""<h1 class='h3'>注册</h1><form method='post' class='col-md-5'><input class='form-control mb-2' name='username' placeholder='用户名'><input class='form-control mb-2' name='password' type='password' placeholder='密码'><select class='form-select mb-2' name='role'><option value='student'>学生</option><option value='teacher'>教师</option></select><button class='btn btn-primary'>注册</button></form>""")

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if request.method == "POST":
            user = get_db().execute("SELECT * FROM users WHERE username=?", (request.form.get("username", "").strip(),)).fetchone()
            if user and check_password_hash(user["password_hash"], request.form.get("password", "")):
                session.clear(); session.update(user_id=user["id"], role=user["role"]); return redirect(url_for("index"))
            flash("用户名或密码错误")
        return page("""<h1 class='h3'>登录</h1><form method='post' class='col-md-5'><input class='form-control mb-2' name='username' placeholder='用户名'><input class='form-control mb-2' type='password' name='password' placeholder='密码'><button class='btn btn-primary'>登录</button></form>""")

    @app.route("/logout")
    def logout(): session.clear(); return redirect(url_for("index"))

    @app.route("/activities/<int:activity_id>")
    def activity_detail(activity_id):
        activity = get_db().execute("SELECT * FROM activities WHERE id=?", (activity_id,)).fetchone()
        if not activity: abort(404)
        return page("""<h1 class='h3'>{{ a.title }}</h1><p>时间：{{ a.activity_time }}<br>地点：{{ a.location }}<br>报名截止：{{ a.deadline }}</p>{% if session.get('role') == 'student' %}<form method='post' action='{{ url_for("register_activity", activity_id=a.id) }}'><button class='btn btn-primary'>报名</button></form>{% endif %}""", a=activity)

    @app.route("/activities/<int:activity_id>/register", methods=["POST"])
    @role_required("student")
    def register_activity(activity_id):
        db = get_db(); activity = db.execute("SELECT * FROM activities WHERE id=?", (activity_id,)).fetchone()
        if not activity or activity["status"] != "published": flash("活动不可报名")
        elif datetime.strptime(activity["deadline"], "%Y-%m-%d %H:%M") < datetime.now(): flash("报名已截止")
        elif db.execute("SELECT 1 FROM registrations WHERE user_id=? AND activity_id=?", (session["user_id"], activity_id)).fetchone(): flash("您已报名该活动")
        elif db.execute("SELECT COUNT(*) FROM registrations WHERE activity_id=?", (activity_id,)).fetchone()[0] >= activity["capacity"]: flash("人数已满")
        else:
            db.execute("INSERT INTO registrations (user_id,activity_id) VALUES (?,?)", (session["user_id"], activity_id)); db.commit(); flash("报名成功")
        return redirect(url_for("activity_detail", activity_id=activity_id))

    @app.route("/my-registrations")
    @role_required("student")
    def my_registrations():
        rows = get_db().execute("SELECT a.* FROM registrations r JOIN activities a ON a.id=r.activity_id WHERE r.user_id=?", (session["user_id"],)).fetchall()
        return page("""<h1 class='h3'>我的报名</h1><ul class='list-group'>{% for a in rows %}<li class='list-group-item'>{{ a.title }} - {{ a.activity_time }}</li>{% else %}<li class='list-group-item'>暂无报名记录。</li>{% endfor %}</ul>""", rows=rows)

    @app.route("/teacher/activities")
    @role_required("teacher")
    def teacher_activities():
        rows = get_db().execute("SELECT * FROM activities WHERE teacher_id=? ORDER BY id DESC", (session["user_id"],)).fetchall()
        return page("""<div class='d-flex justify-content-between'><h1 class='h3'>我的活动</h1><a class='btn btn-primary' href='{{ url_for("new_activity") }}'>发布活动</a></div><ul class='list-group mt-3'>{% for a in rows %}<li class='list-group-item'>{{ a.title }}（{{ a.status }}）<a href='{{ url_for("registration_list", activity_id=a.id) }}'>报名名单</a>{% if a.status=='published' %}<form class='d-inline' method='post' action='{{ url_for("cancel_activity", activity_id=a.id) }}'><button class='btn btn-sm btn-outline-danger'>取消</button></form>{% endif %}</li>{% else %}<li class='list-group-item'>暂无活动。</li>{% endfor %}</ul>""", rows=rows)

    @app.route("/teacher/activities/new", methods=["GET", "POST"])
    @role_required("teacher")
    def new_activity():
        if request.method == "POST":
            try:
                db=get_db(); db.execute("INSERT INTO activities (title,activity_time,location,capacity,deadline,teacher_id) VALUES (?,?,?,?,?,?)", (request.form["title"].strip(), request.form["activity_time"], request.form["location"].strip(), int(request.form["capacity"]), request.form["deadline"], session["user_id"])); db.commit(); flash("活动发布成功"); return redirect(url_for("teacher_activities"))
            except (ValueError, KeyError): flash("请正确填写活动信息")
        return page("""<h1 class='h3'>发布活动</h1><form method='post' class='col-md-6'><input class='form-control mb-2' name='title' placeholder='活动名称'><input class='form-control mb-2' name='activity_time' placeholder='活动时间，如 2026-09-15 14:00'><input class='form-control mb-2' name='location' placeholder='地点'><input class='form-control mb-2' name='capacity' type='number' min='1' placeholder='人数上限'><input class='form-control mb-2' name='deadline' placeholder='报名截止，如 2026-09-14 18:00'><button class='btn btn-primary'>发布</button></form>""")

    @app.route("/teacher/activities/<int:activity_id>/cancel", methods=["POST"])
    @role_required("teacher")
    def cancel_activity(activity_id):
        db=get_db(); result=db.execute("UPDATE activities SET status='cancelled' WHERE id=? AND teacher_id=?", (activity_id, session["user_id"])); db.commit(); flash("活动已取消" if result.rowcount else "无权操作该活动"); return redirect(url_for("teacher_activities"))

    @app.route("/teacher/activities/<int:activity_id>/registrations")
    @role_required("teacher")
    def registration_list(activity_id):
        db=get_db(); activity=db.execute("SELECT * FROM activities WHERE id=? AND teacher_id=?", (activity_id, session["user_id"])).fetchone()
        if not activity: abort(403)
        rows=db.execute("SELECT u.username,r.created_at FROM registrations r JOIN users u ON u.id=r.user_id WHERE r.activity_id=?", (activity_id,)).fetchall()
        return page("""<h1 class='h3'>{{ a.title }}的报名名单</h1><ul class='list-group'>{% for r in rows %}<li class='list-group-item'>{{ r.username }} - {{ r.created_at }}</li>{% else %}<li class='list-group-item'>暂无报名。</li>{% endfor %}</ul>""", a=activity, rows=rows)

    return app


if __name__ == "__main__":
    create_app().run(debug=True)
