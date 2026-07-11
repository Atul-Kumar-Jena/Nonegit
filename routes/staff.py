"""
routes/staff.py - Trek Staff routes
Dashboard, assigned treks, slot/status updates, participants, complete trek.
"""

from functools import wraps
from flask import Blueprint, render_template, request, redirect, url_for, session, flash
from database import db, Staff, Trek, Booking

staff_bp = Blueprint('staff', __name__, url_prefix='/staff')


# --------- DECORATOR: REQUIRE STAFF LOGIN ---------
def gunjan_require_staff_login(f):
    """Check if user is logged in as staff"""
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'staff_id' not in session or session.get('staff_role') != 'staff':
            flash('Please login as staff to continue', 'error')
            return redirect(url_for('auth.gunjan_login_staff'))
        return f(*args, **kwargs)
    return decorated


# --------- STAFF DASHBOARD ---------
@staff_bp.route('/dashboard')
@gunjan_require_staff_login
def gunjan_staff_dashboard():
    """
    Staff Dashboard

    Shows:
    1. Assigned treks
    2. Number of registered users per trek
    3. Trek status
    """

    staff_id = session['staff_id']
    staff = Staff.query.get(staff_id)

    # Get assigned treks
    assigned_treks = Trek.query.filter_by(assigned_staff_id=staff_id).all()

    # Calculate stats
    total_treks = len(assigned_treks)
    total_participants = 0
    for trek in assigned_treks:
        count = trek.gunjan_get_participants_count()
        total_participants += count

    return render_template('staff_dashboard.html',
                           staff=staff,
                           assigned_treks=assigned_treks,
                           total_treks=total_treks,
                           total_participants=total_participants)


# --------- VIEW ASSIGNED TREKS ---------
@staff_bp.route('/treks')
@gunjan_require_staff_login
def gunjan_view_assigned_treks():
    """View all treks assigned to this staff"""

    staff_id = session['staff_id']
    treks = Trek.query.filter_by(assigned_staff_id=staff_id).all()

    return render_template('staff_view_treks.html', treks=treks)


# --------- UPDATE TREK SLOTS ---------
@staff_bp.route('/trek/<int:trek_id>/update-slots', methods=['GET', 'POST'])
@gunjan_require_staff_login
def gunjan_update_slots(trek_id):
    """
    Update available slots for a trek

    Staff can adjust slots based on actual conditions.
    Only the assigned staff can manage the trek.
    """

    trek = Trek.query.get_or_404(trek_id)
    staff_id = session['staff_id']

    # Verify ownership: only assigned staff can manage this trek
    if trek.assigned_staff_id != staff_id:
        flash('You can only manage your assigned treks', 'error')
        return redirect(url_for('staff.gunjan_view_assigned_treks'))

    if request.method == 'POST':
        try:
            new_slots = int(request.form.get('available_slots', 0))

            if new_slots < 0 or new_slots > trek.total_slots:
                flash('Invalid slot count', 'error')
                return redirect(url_for('staff.gunjan_update_slots', trek_id=trek_id))

            trek.available_slots = new_slots
            db.session.commit()

            flash('Slots updated successfully', 'success')
            return redirect(url_for('staff.gunjan_view_assigned_treks'))

        except ValueError:
            flash('Invalid slot number', 'error')
            return redirect(url_for('staff.gunjan_update_slots', trek_id=trek_id))

    return render_template('staff_update_slots.html', trek=trek)


# --------- UPDATE TREK STATUS ---------
@staff_bp.route('/trek/<int:trek_id>/status', methods=['GET', 'POST'])
@gunjan_require_staff_login
def gunjan_update_trek_status(trek_id):
    """Update trek status (open/closed/completed)"""

    trek = Trek.query.get_or_404(trek_id)
    staff_id = session['staff_id']

    if trek.assigned_staff_id != staff_id:
        flash('You can only manage your assigned treks', 'error')
        return redirect(url_for('staff.gunjan_view_assigned_treks'))

    if request.method == 'POST':
        new_status = request.form.get('status')

        if new_status not in ['open', 'closed', 'completed']:
            flash('Invalid status', 'error')
            return redirect(url_for('staff.gunjan_update_trek_status', trek_id=trek_id))

        trek.status = new_status

        # If marked completed, complete all its active bookings too
        if new_status == 'completed':
            bookings = Booking.query.filter_by(trek_id=trek_id, status='booked').all()
            for booking in bookings:
                booking.status = 'completed'

        db.session.commit()

        flash(f'Trek status updated to {new_status}', 'success')
        return redirect(url_for('staff.gunjan_view_assigned_treks'))

    return render_template('staff_update_status.html', trek=trek)


# --------- VIEW PARTICIPANTS ---------
@staff_bp.route('/trek/<int:trek_id>/participants')
@gunjan_require_staff_login
def gunjan_view_participants(trek_id):
    """View all registered participants for a trek"""

    trek = Trek.query.get_or_404(trek_id)
    staff_id = session['staff_id']

    if trek.assigned_staff_id != staff_id:
        flash('You can only view participants of your assigned treks', 'error')
        return redirect(url_for('staff.gunjan_view_assigned_treks'))

    # Get booked participants
    bookings = Booking.query.filter_by(trek_id=trek_id, status='booked').all()
    participants = [booking.user for booking in bookings]

    return render_template('staff_view_participants.html',
                           trek=trek,
                           participants=participants,
                           booking_count=len(participants))


# --------- MARK TREK COMPLETED ---------
@staff_bp.route('/trek/<int:trek_id>/complete', methods=['POST'])
@gunjan_require_staff_login
def gunjan_complete_trek(trek_id):
    """Mark trek as completed and update all bookings"""

    trek = Trek.query.get_or_404(trek_id)
    staff_id = session['staff_id']

    if trek.assigned_staff_id != staff_id:
        flash('You can only manage your assigned treks', 'error')
        return redirect(url_for('staff.gunjan_view_assigned_treks'))

    # Mark trek as completed
    trek.status = 'completed'

    # Mark all active bookings as completed
    bookings = Booking.query.filter_by(trek_id=trek_id, status='booked').all()
    for booking in bookings:
        booking.status = 'completed'

    db.session.commit()

    flash('Trek marked as completed', 'success')
    return redirect(url_for('staff.gunjan_view_assigned_treks'))
