"""
routes/user.py - User (Trekker) routes
Dashboard, browse/search treks, book/cancel bookings, history, profile.
"""

from functools import wraps
from flask import Blueprint, render_template, request, redirect, url_for, session, flash
from database import db, User, Trek, Booking

user_bp = Blueprint('user', __name__, url_prefix='/user')


# --------- DECORATOR: REQUIRE USER LOGIN ---------
def gunjan_require_user_login(f):
    """Check if user is logged in as trekker"""
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session or session.get('user_role') != 'trekker':
            flash('Please login to continue', 'error')
            return redirect(url_for('auth.gunjan_login_user'))
        return f(*args, **kwargs)
    return decorated


# --------- USER DASHBOARD ---------
@user_bp.route('/dashboard')
@gunjan_require_user_login
def gunjan_dashboard():
    """
    Trekker Dashboard

    Shows:
    1. Available treks
    2. Booked treks
    3. Quick stats
    """

    user_id = session['user_id']
    user = User.query.get(user_id)

    # Get active bookings with their treks
    bookings = Booking.query.filter_by(user_id=user_id, status='booked').all()

    # Get available treks
    available_treks = Trek.query.filter_by(status='open').all()

    return render_template('user_dashboard.html',
                           user=user,
                           bookings=bookings,
                           available_treks=available_treks)


# --------- BROWSE TREKS ---------
@user_bp.route('/browse')
@gunjan_require_user_login
def gunjan_browse_treks():
    """Browse all open treks"""

    treks = Trek.query.filter_by(status='open').all()
    return render_template('user_browse_treks.html', treks=treks)


# --------- TREK DETAILS ---------
@user_bp.route('/trek/<int:trek_id>')
@gunjan_require_user_login
def gunjan_trek_details(trek_id):
    """
    View trek details

    Shows:
    1. Trek information
    2. Available slots
    3. Staff assigned
    4. Whether user has already booked
    """

    trek = Trek.query.get_or_404(trek_id)
    user_id = session['user_id']

    # Check if user already booked
    existing_booking = Booking.query.filter_by(
        user_id=user_id,
        trek_id=trek_id,
        status='booked'
    ).first()

    return render_template('user_trek_details.html',
                           trek=trek,
                           already_booked=existing_booking is not None)


# --------- SEARCH & FILTER ---------
@user_bp.route('/search')
@gunjan_require_user_login
def gunjan_search_treks():
    """
    Search and filter treks by:
    1. Difficulty (Easy, Moderate, Hard)
    2. Location

    Only open treks are shown
    """

    difficulty = request.args.get('difficulty', '').strip()
    location = request.args.get('location', '').strip()

    query = Trek.query.filter_by(status='open')

    if difficulty:
        query = query.filter_by(difficulty=difficulty)

    if location:
        query = query.filter(Trek.location.ilike(f'%{location}%'))

    treks = query.all()

    return render_template('user_search_results.html',
                           treks=treks,
                           difficulty=difficulty,
                           location=location)


# --------- BOOK TREK (CRITICAL FUNCTION) ---------
@user_bp.route('/trek/<int:trek_id>/book', methods=['POST'])
@gunjan_require_user_login
def gunjan_book_trek(trek_id):
    """
    Book a trek (OVERBOOKING PREVENTION)

    Critical Validations:
    1. User must not be blacklisted
    2. Trek status must be 'open'
    3. Available slots must be > 0
    4. User must not already have an active booking for this trek

    Process:
    1. Validate all conditions
    2. Create booking record
    3. Reduce available slots
    4. Save to database
    """

    trek = Trek.query.get_or_404(trek_id)
    user_id = session['user_id']
    user = User.query.get(user_id)

    # VALIDATION 1: User must not be blacklisted
    if user.gunjan_is_blacklisted():
        flash('Your account is blacklisted. Cannot book treks.', 'error')
        return redirect(url_for('user.gunjan_dashboard'))

    # VALIDATION 2: Trek must be open
    if not trek.gunjan_is_open():
        flash('This trek is not open for booking', 'error')
        return redirect(url_for('user.gunjan_trek_details', trek_id=trek_id))

    # VALIDATION 3: Slots must be available
    if not trek.gunjan_has_slots():
        flash('No slots available. Trek is full.', 'error')
        return redirect(url_for('user.gunjan_trek_details', trek_id=trek_id))

    # VALIDATION 4: User should not already have booked this trek
    existing_booking = Booking.query.filter_by(
        user_id=user_id,
        trek_id=trek_id,
        status='booked'
    ).first()

    if existing_booking:
        flash('You have already booked this trek', 'error')
        return redirect(url_for('user.gunjan_trek_details', trek_id=trek_id))

    # BOOKING PROCESS
    try:
        # Create booking
        booking = Booking(
            user_id=user_id,
            trek_id=trek_id,
            status='booked'
        )

        # Reduce slots (CRITICAL FOR OVERBOOKING PREVENTION)
        trek.gunjan_reduce_slots()

        # Save to database
        db.session.add(booking)
        db.session.commit()

        flash('Trek booked successfully! Check your bookings.', 'success')
        return redirect(url_for('user.gunjan_dashboard'))

    except Exception:
        db.session.rollback()
        flash('Error booking trek. Please try again.', 'error')
        return redirect(url_for('user.gunjan_trek_details', trek_id=trek_id))


# --------- CANCEL BOOKING ---------
@user_bp.route('/booking/<int:booking_id>/cancel', methods=['POST'])
@gunjan_require_user_login
def gunjan_cancel_booking(booking_id):
    """
    Cancel a booking

    Process:
    1. Verify booking belongs to user
    2. Only active bookings can be cancelled
    3. Increase trek slots
    4. Mark booking as cancelled
    """

    booking = Booking.query.get_or_404(booking_id)
    user_id = session['user_id']

    # Verify ownership
    if booking.user_id != user_id:
        flash('Unauthorized action', 'error')
        return redirect(url_for('user.gunjan_dashboard'))

    # Only active bookings can be cancelled
    if not booking.gunjan_is_active():
        flash('This booking cannot be cancelled', 'error')
        return redirect(url_for('user.gunjan_booking_history'))

    # Get trek and increase slots
    trek = booking.trek
    trek.gunjan_increase_slots()

    # Cancel booking
    booking.status = 'cancelled'

    db.session.commit()

    flash('Booking cancelled successfully', 'success')
    return redirect(url_for('user.gunjan_dashboard'))


# --------- BOOKING HISTORY ---------
@user_bp.route('/bookings')
@gunjan_require_user_login
def gunjan_booking_history():
    """View complete booking history (booked, cancelled, completed)"""

    user_id = session['user_id']
    bookings = Booking.query.filter_by(user_id=user_id).order_by(
        Booking.booking_date.desc()).all()

    return render_template('user_booking_history.html', bookings=bookings)


# --------- EDIT PROFILE ---------
@user_bp.route('/profile/edit', methods=['GET', 'POST'])
@gunjan_require_user_login
def gunjan_edit_profile():
    """Edit user profile (name and email)"""

    user_id = session['user_id']
    user = User.query.get(user_id)

    if request.method == 'POST':
        name = request.form.get('name', '').strip()
        email = request.form.get('email', '').strip()

        if not name or not email:
            flash('All fields are required', 'error')
            return redirect(url_for('user.gunjan_edit_profile'))

        # Check if email is taken by another user
        existing = User.query.filter_by(email=email).first()
        if existing and existing.user_id != user_id:
            flash('Email already in use', 'error')
            return redirect(url_for('user.gunjan_edit_profile'))

        user.name = name
        user.email = email

        # Optional password change
        new_password = request.form.get('new_password', '')
        if new_password:
            if len(new_password) < 6:
                flash('Password must be at least 6 characters', 'error')
                return redirect(url_for('user.gunjan_edit_profile'))
            user.gunjan_set_password(new_password)

        db.session.commit()

        # Update session
        session['user_name'] = name

        flash('Profile updated successfully', 'success')
        return redirect(url_for('user.gunjan_dashboard'))

    return render_template('user_edit_profile.html', user=user)
