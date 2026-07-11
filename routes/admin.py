"""
routes/admin.py - Admin routes
Dashboard, trek management, staff approval/assignment, user management, search.
"""

from functools import wraps
from datetime import datetime
from flask import Blueprint, render_template, request, redirect, url_for, session, flash
from database import db, User, Staff, Trek, Booking

admin_bp = Blueprint('admin', __name__, url_prefix='/admin')


# --------- DECORATOR: REQUIRE ADMIN ---------
def gunjan_require_admin(f):
    """Check if user is logged in as admin"""
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_role' not in session or session['user_role'] != 'admin':
            flash('Unauthorized access', 'error')
            return redirect(url_for('auth.gunjan_login_admin'))
        return f(*args, **kwargs)
    return decorated


# --------- ADMIN DASHBOARD ---------
@admin_bp.route('/dashboard')
@gunjan_require_admin
def gunjan_admin_dashboard():
    """
    Admin Dashboard with Statistics

    Shows:
    1. Total treks
    2. Total users
    3. Total staff
    4. Total bookings
    5. Pending staff approvals
    6. Open treks
    7. Popular treks chart (bookings per trek)
    """

    total_treks = Trek.query.count()
    total_users = User.query.filter_by(role='trekker').count()
    total_staff = Staff.query.count()
    total_bookings = Booking.query.count()
    pending_staff = Staff.query.filter_by(status='pending').count()
    open_treks = Trek.query.filter_by(status='open').count()

    stats = {
        'total_treks': total_treks,
        'total_users': total_users,
        'total_staff': total_staff,
        'total_bookings': total_bookings,
        'pending_staff': pending_staff,
        'open_treks': open_treks
    }

    # Data for popular treks chart (CSS progress bars, no JS)
    treks = Trek.query.all()
    chart_data = []
    for trek in treks:
        count = trek.gunjan_get_participants_count()
        chart_data.append({'name': trek.name, 'count': count, 'total': trek.total_slots})

    return render_template('admin_dashboard.html', stats=stats, chart_data=chart_data)


# --------- CREATE TREK ---------
@admin_bp.route('/create-trek', methods=['GET', 'POST'])
@gunjan_require_admin
def gunjan_create_trek():
    """
    Create a new trek

    Steps:
    1. Validate all fields
    2. Parse dates
    3. Set initial status to 'pending'
    4. Save to database
    """

    if request.method == 'POST':
        name = request.form.get('name', '').strip()
        location = request.form.get('location', '').strip()
        difficulty = request.form.get('difficulty')
        duration = request.form.get('duration')
        total_slots = request.form.get('total_slots')
        start_date = request.form.get('start_date')
        end_date = request.form.get('end_date')
        description = request.form.get('description', '').strip()

        # Validation
        if not all([name, location, difficulty, duration, total_slots, start_date, end_date]):
            flash('All fields are required', 'error')
            return redirect(url_for('admin.gunjan_create_trek'))

        try:
            start = datetime.strptime(start_date, '%Y-%m-%d').date()
            end = datetime.strptime(end_date, '%Y-%m-%d').date()

            if end <= start:
                flash('End date must be after start date', 'error')
                return redirect(url_for('admin.gunjan_create_trek'))

            if int(duration) <= 0 or int(total_slots) <= 0:
                flash('Duration and slots must be positive numbers', 'error')
                return redirect(url_for('admin.gunjan_create_trek'))

            # Create trek
            new_trek = Trek(
                name=name,
                location=location,
                difficulty=difficulty,
                duration=int(duration),
                total_slots=int(total_slots),
                available_slots=int(total_slots),
                start_date=start,
                end_date=end,
                description=description,
                status='pending'
            )

            db.session.add(new_trek)
            db.session.commit()

            flash('Trek created successfully', 'success')
            return redirect(url_for('admin.gunjan_view_all_treks'))

        except ValueError:
            flash('Invalid date or number format', 'error')
            return redirect(url_for('admin.gunjan_create_trek'))

    return render_template('admin_create_trek.html')


# --------- VIEW ALL TREKS ---------
@admin_bp.route('/treks')
@gunjan_require_admin
def gunjan_view_all_treks():
    """View all treks with their details"""

    treks = Trek.query.all()
    return render_template('admin_view_treks.html', treks=treks)


# --------- APPROVE TREK ---------
@admin_bp.route('/trek/<int:trek_id>/approve', methods=['POST'])
@gunjan_require_admin
def gunjan_approve_trek(trek_id):
    """
    Approve trek (change status from pending to approved)
    """

    trek = Trek.query.get_or_404(trek_id)
    trek.status = 'approved'
    db.session.commit()

    flash('Trek approved successfully', 'success')
    return redirect(url_for('admin.gunjan_view_all_treks'))


# --------- EDIT TREK ---------
@admin_bp.route('/trek/<int:trek_id>/edit', methods=['GET', 'POST'])
@gunjan_require_admin
def gunjan_edit_trek(trek_id):
    """Edit trek details"""

    trek = Trek.query.get_or_404(trek_id)

    if request.method == 'POST':
        name = request.form.get('name', '').strip()
        location = request.form.get('location', '').strip()
        difficulty = request.form.get('difficulty')
        duration = request.form.get('duration')
        description = request.form.get('description', '').strip()

        if not all([name, location, difficulty, duration]):
            flash('All fields are required', 'error')
            return redirect(url_for('admin.gunjan_edit_trek', trek_id=trek_id))

        try:
            trek.name = name
            trek.location = location
            trek.difficulty = difficulty
            trek.duration = int(duration)
            trek.description = description

            db.session.commit()
            flash('Trek updated successfully', 'success')
            return redirect(url_for('admin.gunjan_view_all_treks'))

        except ValueError:
            flash('Invalid duration', 'error')
            return redirect(url_for('admin.gunjan_edit_trek', trek_id=trek_id))

    return render_template('admin_edit_trek.html', trek=trek)


# --------- CLOSE TREK ---------
@admin_bp.route('/trek/<int:trek_id>/close', methods=['POST'])
@gunjan_require_admin
def gunjan_close_trek(trek_id):
    """Close trek (no more bookings allowed)"""

    trek = Trek.query.get_or_404(trek_id)
    trek.status = 'closed'
    db.session.commit()

    flash('Trek closed successfully', 'success')
    return redirect(url_for('admin.gunjan_view_all_treks'))


# --------- DELETE TREK ---------
@admin_bp.route('/trek/<int:trek_id>/delete', methods=['POST'])
@gunjan_require_admin
def gunjan_delete_trek(trek_id):
    """
    Delete (remove) a trek

    Its bookings are cancelled first so booking history stays consistent.
    """

    trek = Trek.query.get_or_404(trek_id)

    # Cancel all active bookings of this trek before deleting
    bookings = Booking.query.filter_by(trek_id=trek_id).all()
    for booking in bookings:
        db.session.delete(booking)

    db.session.delete(trek)
    db.session.commit()

    flash('Trek deleted successfully', 'success')
    return redirect(url_for('admin.gunjan_view_all_treks'))


# --------- VIEW ALL STAFF ---------
@admin_bp.route('/staff')
@gunjan_require_admin
def gunjan_view_staff():
    """View all staff members (pending, approved, blacklisted)"""

    staff_list = Staff.query.all()
    return render_template('admin_view_staff.html', staff=staff_list)


# --------- VIEW PENDING STAFF ---------
@admin_bp.route('/staff/pending')
@gunjan_require_admin
def gunjan_pending_staff():
    """View staff members waiting for approval"""

    pending = Staff.query.filter_by(status='pending').all()
    return render_template('admin_pending_staff.html', staff=pending)


# --------- APPROVE STAFF ---------
@admin_bp.route('/staff/<int:staff_id>/approve', methods=['POST'])
@gunjan_require_admin
def gunjan_approve_staff(staff_id):
    """Approve staff registration"""

    staff = Staff.query.get_or_404(staff_id)
    staff.status = 'approved'
    staff.approved_at = datetime.now()
    db.session.commit()

    flash(f'Staff {staff.name} approved successfully', 'success')
    return redirect(url_for('admin.gunjan_view_staff'))


# --------- ASSIGN STAFF TO TREK ---------
@admin_bp.route('/trek/<int:trek_id>/assign-staff', methods=['GET', 'POST'])
@gunjan_require_admin
def gunjan_assign_staff(trek_id):
    """
    Assign approved staff to a trek

    Process:
    1. Get trek
    2. Show list of approved staff
    3. Assign selected staff
    4. Change trek status to 'open'
    """

    trek = Trek.query.get_or_404(trek_id)
    approved_staff = Staff.query.filter_by(status='approved').all()

    if request.method == 'POST':
        staff_id = request.form.get('staff_id')

        if not staff_id:
            flash('Please select a staff member', 'error')
            return redirect(url_for('admin.gunjan_assign_staff', trek_id=trek_id))

        trek.assigned_staff_id = int(staff_id)
        trek.status = 'open'  # Trek is now open for bookings
        db.session.commit()

        flash('Staff assigned and trek opened for bookings', 'success')
        return redirect(url_for('admin.gunjan_view_all_treks'))

    return render_template('admin_assign_staff.html', trek=trek, staff=approved_staff)


# --------- VIEW ALL USERS ---------
@admin_bp.route('/users')
@gunjan_require_admin
def gunjan_view_users():
    """View all trekker users"""

    users = User.query.filter_by(role='trekker').all()
    return render_template('admin_view_users.html', users=users)


# --------- BLACKLIST USER ---------
@admin_bp.route('/user/<int:user_id>/blacklist', methods=['POST'])
@gunjan_require_admin
def gunjan_blacklist_user(user_id):
    """Blacklist a user"""

    user = User.query.get_or_404(user_id)
    user.status = 'blacklisted'
    db.session.commit()

    flash(f'User {user.name} has been blacklisted', 'success')
    return redirect(url_for('admin.gunjan_view_users'))


# --------- ACTIVATE (UN-BLACKLIST) USER ---------
@admin_bp.route('/user/<int:user_id>/activate', methods=['POST'])
@gunjan_require_admin
def gunjan_activate_user(user_id):
    """Remove user from blacklist (reactivate)"""

    user = User.query.get_or_404(user_id)
    user.status = 'active'
    db.session.commit()

    flash(f'User {user.name} has been reactivated', 'success')
    return redirect(url_for('admin.gunjan_view_users'))


# --------- BLACKLIST STAFF ---------
@admin_bp.route('/staff/<int:staff_id>/blacklist', methods=['POST'])
@gunjan_require_admin
def gunjan_blacklist_staff(staff_id):
    """Blacklist a staff member"""

    staff = Staff.query.get_or_404(staff_id)
    staff.status = 'blacklisted'
    db.session.commit()

    flash(f'Staff {staff.name} has been blacklisted', 'success')
    return redirect(url_for('admin.gunjan_view_staff'))


# --------- ACTIVATE (UN-BLACKLIST) STAFF ---------
@admin_bp.route('/staff/<int:staff_id>/activate', methods=['POST'])
@gunjan_require_admin
def gunjan_activate_staff(staff_id):
    """Remove staff from blacklist (back to approved)"""

    staff = Staff.query.get_or_404(staff_id)
    staff.status = 'approved'
    db.session.commit()

    flash(f'Staff {staff.name} has been reactivated', 'success')
    return redirect(url_for('admin.gunjan_view_staff'))


# --------- VIEW ALL BOOKINGS ---------
@admin_bp.route('/bookings')
@gunjan_require_admin
def gunjan_view_bookings():
    """View all bookings in the system (complete historical data)"""

    bookings = Booking.query.order_by(Booking.booking_date.desc()).all()
    return render_template('admin_view_bookings.html', bookings=bookings)


# --------- SEARCH ---------
@admin_bp.route('/search', methods=['GET'])
@gunjan_require_admin
def gunjan_search():
    """
    Search functionality for treks, users, and staff

    Searches by name, email/location, or exact ID.
    Uses ilike for case-insensitive search.
    """

    search_type = request.args.get('type', 'trek')
    query = request.args.get('query', '').strip()
    results = []

    if not query:
        flash('Please enter a search query', 'error')
        return render_template('admin_search_results.html', results=[],
                               search_type=search_type, query=query)

    if search_type == 'trek':
        results = Trek.query.filter(
            (Trek.name.ilike(f'%{query}%')) |
            (Trek.location.ilike(f'%{query}%'))
        ).all()
        # Also allow searching by exact ID
        if query.isdigit():
            trek_by_id = Trek.query.get(int(query))
            if trek_by_id and trek_by_id not in results:
                results.append(trek_by_id)

    elif search_type == 'user':
        results = User.query.filter(User.role == 'trekker').filter(
            (User.name.ilike(f'%{query}%')) |
            (User.email.ilike(f'%{query}%'))
        ).all()
        if query.isdigit():
            user_by_id = User.query.filter_by(user_id=int(query), role='trekker').first()
            if user_by_id and user_by_id not in results:
                results.append(user_by_id)

    elif search_type == 'staff':
        results = Staff.query.filter(
            (Staff.name.ilike(f'%{query}%')) |
            (Staff.email.ilike(f'%{query}%'))
        ).all()
        if query.isdigit():
            staff_by_id = Staff.query.get(int(query))
            if staff_by_id and staff_by_id not in results:
                results.append(staff_by_id)

    return render_template('admin_search_results.html',
                           results=results,
                           search_type=search_type,
                           query=query)
