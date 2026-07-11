"""
app.py - Trekking Management Application
Main Flask application: configuration, blueprint registration,
programmatic database creation and default admin seeding.

Run:  python app.py
App:  http://127.0.0.1:5000
"""

from flask import Flask, render_template
from datetime import timedelta

from database import db, User

app = Flask(__name__)

# Configuration
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///trekking.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SECRET_KEY'] = 'gunjan-trekking-app-secret-key'
app.permanent_session_lifetime = timedelta(hours=2)

# Initialize database
db.init_app(app)

# Register blueprints
from routes.auth import auth_bp
from routes.admin import admin_bp
from routes.staff import staff_bp
from routes.user import user_bp
from routes.api import api_bp

app.register_blueprint(auth_bp)
app.register_blueprint(admin_bp)
app.register_blueprint(staff_bp)
app.register_blueprint(user_bp)
app.register_blueprint(api_bp)


# --------- HOME PAGE ---------
@app.route('/')
def gunjan_home():
    """Public landing page with login/register options for all roles"""
    return render_template('home.html')


def gunjan_init_database():
    """
    Initialize database with tables and default admin user.
    Tables are created programmatically (db.create_all()) -
    no manual database creation is used anywhere.
    """
    with app.app_context():
        # Create all tables
        db.create_all()

        # Check if admin already exists
        admin = User.query.filter_by(email='admin@trekking.com', role='admin').first()

        if not admin:
            # Create default admin (pre-existing superuser, no registration)
            admin = User(
                name='Admin',
                email='admin@trekking.com',
                role='admin',
                status='active'
            )
            admin.gunjan_set_password('admin123')
            db.session.add(admin)
            db.session.commit()
            print("* Admin created successfully")
            print("  Email: admin@trekking.com")
            print("  Password: admin123")

        print("* Database initialized")


# Initialize database on startup
gunjan_init_database()


if __name__ == '__main__':
    # Run app
    app.run(debug=True, port=5000)
