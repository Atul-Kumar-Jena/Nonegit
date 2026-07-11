"""
database.py - Database models for Trekking Management Application
All tables are created programmatically using SQLAlchemy (db.create_all()).
"""

from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime

db = SQLAlchemy()


# --------- USER MODEL ---------
class User(db.Model):
    __tablename__ = 'user'

    user_id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(100), unique=True, nullable=False)
    password = db.Column(db.String(200), nullable=False)
    role = db.Column(db.String(20), default='trekker')  # trekker or admin
    status = db.Column(db.String(20), default='active')  # active, blacklisted
    created_at = db.Column(db.DateTime, default=datetime.now)

    # Relationships
    bookings = db.relationship('Booking', backref='user', lazy=True)

    def gunjan_set_password(self, password):
        """Hash password using werkzeug"""
        self.password = generate_password_hash(password)

    def gunjan_check_password(self, password):
        """Verify password against hash"""
        return check_password_hash(self.password, password)

    def gunjan_is_blacklisted(self):
        """Check if user is blacklisted"""
        return self.status == 'blacklisted'


# --------- STAFF MODEL ---------
class Staff(db.Model):
    __tablename__ = 'staff'

    staff_id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    email = db.Column(db.String(100), unique=True, nullable=False)
    password = db.Column(db.String(200), nullable=False)
    phone = db.Column(db.String(15), nullable=False)
    status = db.Column(db.String(20), default='pending')  # pending, approved, blacklisted
    approved_at = db.Column(db.DateTime)
    created_at = db.Column(db.DateTime, default=datetime.now)

    # Relationships
    treks = db.relationship('Trek', backref='assigned_staff', lazy=True)

    def gunjan_set_password(self, password):
        """Hash password"""
        self.password = generate_password_hash(password)

    def gunjan_check_password(self, password):
        """Verify password"""
        return check_password_hash(self.password, password)

    def gunjan_is_approved(self):
        """Check if staff is approved by admin"""
        return self.status == 'approved'

    def gunjan_is_pending(self):
        """Check if approval is pending"""
        return self.status == 'pending'


# --------- TREK MODEL ---------
class Trek(db.Model):
    __tablename__ = 'trek'

    trek_id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    location = db.Column(db.String(100), nullable=False)
    difficulty = db.Column(db.String(20), nullable=False)  # Easy, Moderate, Hard
    duration = db.Column(db.Integer, nullable=False)  # in days
    total_slots = db.Column(db.Integer, nullable=False)
    available_slots = db.Column(db.Integer, nullable=False)
    assigned_staff_id = db.Column(db.Integer, db.ForeignKey('staff.staff_id'))
    status = db.Column(db.String(20), default='pending')  # pending, approved, open, closed, completed
    start_date = db.Column(db.Date, nullable=False)
    end_date = db.Column(db.Date, nullable=False)
    description = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.now)

    # Relationships
    bookings = db.relationship('Booking', backref='trek', lazy=True)

    def gunjan_is_open(self):
        """Check if trek is open for booking"""
        return self.status == 'open'

    def gunjan_has_slots(self):
        """Check if slots are available"""
        return self.available_slots > 0

    def gunjan_reduce_slots(self):
        """Reduce available slots by 1 (when user books)"""
        if self.available_slots > 0:
            self.available_slots -= 1
            return True
        return False

    def gunjan_increase_slots(self):
        """Increase available slots by 1 (when booking cancelled)"""
        if self.available_slots < self.total_slots:
            self.available_slots += 1
            return True
        return False

    def gunjan_get_participants_count(self):
        """Get number of users booked for this trek"""
        return Booking.query.filter_by(trek_id=self.trek_id, status='booked').count()


# --------- BOOKING MODEL ---------
class Booking(db.Model):
    __tablename__ = 'booking'

    booking_id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.user_id'), nullable=False)
    trek_id = db.Column(db.Integer, db.ForeignKey('trek.trek_id'), nullable=False)
    booking_date = db.Column(db.DateTime, default=datetime.now)
    status = db.Column(db.String(20), default='booked')  # booked, cancelled, completed

    def gunjan_is_active(self):
        """Check if booking is still active"""
        return self.status == 'booked'

    def __repr__(self):
        return f'<Booking {self.booking_id}>'
