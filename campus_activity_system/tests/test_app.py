import os
import tempfile
import unittest

from app import create_app, get_db


class CampusActivitySystemTestCase(unittest.TestCase):
    def setUp(self):
        self.db_file = tempfile.NamedTemporaryFile(delete=False)
        self.db_file.close()
        self.app = create_app({"TESTING": True, "DATABASE": self.db_file.name, "SECRET_KEY": "test"})
        self.client = self.app.test_client()
        with self.app.app_context():
            db = get_db()
            db.execute("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ("teacher", "", "teacher"))
            db.execute("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ("student", "", "student"))
            db.execute("INSERT INTO activities (title, activity_time, location, capacity, deadline, status, teacher_id) VALUES (?, ?, ?, ?, ?, ?, ?)", ("羽毛球赛", "2026-09-15 14:00", "体育馆", 1, "2026-09-14 18:00", "published", 1))
            db.commit()

    def tearDown(self):
        os.unlink(self.db_file.name)

    def login(self, username, role):
        with self.client.session_transaction() as session:
            session["user_id"] = 1 if username == "teacher" else 2
            session["role"] = role

    def test_public_list_shows_published_activity(self):
        response = self.client.get("/")
        self.assertIn("羽毛球赛".encode(), response.data)

    def test_student_cannot_register_twice(self):
        self.login("student", "student")
        self.client.post("/activities/1/register", follow_redirects=True)
        response = self.client.post("/activities/1/register", follow_redirects=True)
        self.assertIn("已报名".encode(), response.data)
        with self.app.app_context():
            self.assertEqual(get_db().execute("SELECT COUNT(*) FROM registrations").fetchone()[0], 1)

    def test_capacity_blocks_second_student(self):
        self.login("student", "student")
        self.client.post("/activities/1/register", follow_redirects=True)
        with self.app.app_context():
            db = get_db()
            db.execute("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ("student2", "", "student"))
            db.commit()
        with self.client.session_transaction() as session:
            session["user_id"] = 3
            session["role"] = "student"
        response = self.client.post("/activities/1/register", follow_redirects=True)
        self.assertIn("人数已满".encode(), response.data)


if __name__ == "__main__":
    unittest.main()
