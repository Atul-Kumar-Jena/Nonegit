"""
routes/api.py - JSON API resources (optional feature)
Read-only endpoints for treks, users, and bookings.
"""

from flask import Blueprint, jsonify
from database import User, Trek, Booking

api_bp = Blueprint('api', __name__, url_prefix='/api')


def gunjan_trek_to_dict(trek):
    """Convert Trek object to dictionary for JSON response"""
    return {
        'trek_id': trek.trek_id,
        'name': trek.name,
        'location': trek.location,
        'difficulty': trek.difficulty,
        'duration': trek.duration,
        'total_slots': trek.total_slots,
        'available_slots': trek.available_slots,
        'assigned_staff_id': trek.assigned_staff_id,
        'status': trek.status,
        'start_date': str(trek.start_date),
        'end_date': str(trek.end_date),
        'description': trek.description
    }


def gunjan_user_to_dict(user):
    """Convert User object to dictionary (no password exposed)"""
    return {
        'user_id': user.user_id,
        'name': user.name,
        'email': user.email,
        'role': user.role,
        'status': user.status
    }


def gunjan_booking_to_dict(booking):
    """Convert Booking object to dictionary"""
    return {
        'booking_id': booking.booking_id,
        'user_id': booking.user_id,
        'trek_id': booking.trek_id,
        'booking_date': str(booking.booking_date),
        'status': booking.status
    }


# --------- GET ALL TREKS ---------
@api_bp.route('/treks', methods=['GET'])
def gunjan_api_treks():
    """Return all treks as JSON"""
    treks = Trek.query.all()
    return jsonify({'treks': [gunjan_trek_to_dict(t) for t in treks]})


# --------- GET SINGLE TREK ---------
@api_bp.route('/treks/<int:trek_id>', methods=['GET'])
def gunjan_api_trek_details(trek_id):
    """Return a single trek as JSON"""
    trek = Trek.query.get(trek_id)
    if not trek:
        return jsonify({'error': 'Trek not found'}), 404
    return jsonify(gunjan_trek_to_dict(trek))


# --------- GET ALL USERS ---------
@api_bp.route('/users', methods=['GET'])
def gunjan_api_users():
    """Return all trekker users as JSON"""
    users = User.query.filter_by(role='trekker').all()
    return jsonify({'users': [gunjan_user_to_dict(u) for u in users]})


# --------- GET ALL BOOKINGS ---------
@api_bp.route('/bookings', methods=['GET'])
def gunjan_api_bookings():
    """Return all bookings as JSON"""
    bookings = Booking.query.all()
    return jsonify({'bookings': [gunjan_booking_to_dict(b) for b in bookings]})
