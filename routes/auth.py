"""
routes/auth.py - Authentication routes
Registration and login for Users (Trekkers) and Staff, login for Admin, logout.
"""

from flask import Blueprint, render_template, request, redirect, url_for, session, flash
from database import db, User, Staff

auth_bp = Blueprint('auth', __name__, url_prefix='/auth')


# --------- USER REGISTRATION ---------
@auth_bp.route('/register-user', methods=['GET', 'POST'])
def gunjan_register_user():
    """
    User (Trekker) Registration

    Validation:
    1. All fields must be filled
    2. Passwords must match
    3. Email must not already exist
    """

    if request.method == 'POST':
        name = request.form.get('name', '').strip()
        email = request.form.get('email', '').strip()
        password = request.form.get('password', '')
        confirm = request.form.get('confirm_password', '')

        # Validation checks
        if not name or not email or not password or not confirm:
            flash('All fields are required', 'error')
            return redirect(url_for('auth.gunjan_register_user'))

        if password != confirm:
            flash('Passwords do not match', 'error')
            return redirect(url_for('auth.gunjan_register_user'))

        if len(password) < 6:
            flash('Password must be at least 6 characters', 'error')
            return redirect(url_for('auth.gunjan_register_user'))

        # Check if email already registered
        existing_user = User.query.filter_by(email=email).first()
        if existing_user:
            flash('Email already registered', 'error')
            return redirect(url_for('auth.gunjan_register_user'))

        # Create new user
        new_user = User(
            name=name,
            email=email,
            role='trekker',
            status='active'
        )
        new_user.gunjan_set_password(password)

        db.session.add(new_user)
        db.session.commit()

        flash('Registration successful! Please login', 'success')
        return redirect(url_for('auth.gunjan_login_user'))

    return render_template('register_user.html')


# --------- STAFF REGISTRATION ---------
@auth_bp.route('/register-staff', methods=['GET', 'POST'])
def gunjan_register_staff():
    """
    Staff Registration

    Status: Pending (requires admin approval before access)
    """

    if request.method == 'POST':
        name = request.form.get('name', '').strip()
        email = request.form.get('email', '').strip()
        phone = request.form.get('phone', '').strip()
        password = request.form.get('password', '')
        confirm = request.form.get('confirm_password', '')

        # Validation
        if not all([name, email, phone, password, confirm]):
            flash('All fields are required', 'error')
            return redirect(url_for('auth.gunjan_register_staff'))

        if password != confirm:
            flash('Passwords do not match', 'error')
            return redirect(url_for('auth.gunjan_register_staff'))

        if len(password) < 6:
            flash('Password must be at least 6 characters', 'error')
            return redirect(url_for('auth.gunjan_register_staff'))

        if len(phone) < 10:
            flash('Invalid phone number', 'error')
            return redirect(url_for('auth.gunjan_register_staff'))

        # Check if email already exists
        existing_staff = Staff.query.filter_by(email=email).first()
        if existing_staff:
            flash('Email already registered', 'error')
            return redirect(url_for('auth.gunjan_register_staff'))

        # Create new staff (status = pending)
        new_staff = Staff(
            name=name,
            email=email,
            phone=phone,
            status='pending'
        )
        new_staff.gunjan_set_password(password)

        db.session.add(new_staff)
        db.session.commit()

        flash('Registration successful! Waiting for admin approval', 'info')
        return redirect(url_for('auth.gunjan_login_staff'))

    return render_template('register_staff.html')


# --------- USER LOGIN ---------
@auth_bp.route('/login-user', methods=['GET', 'POST'])
def gunjan_login_user():
    """
    Trekker Login

    Checks:
    1. Email and password match
    2. User is not blacklisted
    """

    if request.method == 'POST':
        email = request.form.get('email', '').strip()
        password = request.form.get('password', '')

        # Find user
        user = User.query.filter_by(email=email, role='trekker').first()

        # Verify credentials
        if not user or not user.gunjan_check_password(password):
            flash('Invalid email or password', 'error')
            return redirect(url_for('auth.gunjan_login_user'))

        # Check if blacklisted
        if user.gunjan_is_blacklisted():
            flash('Your account has been blacklisted', 'error')
            return redirect(url_for('auth.gunjan_login_user'))

        # Set session
        session['user_id'] = user.user_id
        session['user_role'] = 'trekker'
        session['user_name'] = user.name
        session.permanent = True

        flash(f'Welcome {user.name}!', 'success')
        return redirect(url_for('user.gunjan_dashboard'))

    return render_template('login_user.html')


# --------- STAFF LOGIN ---------
@auth_bp.route('/login-staff', methods=['GET', 'POST'])
def gunjan_login_staff():
    """
    Staff Login

    Checks:
    1. Credentials match
    2. Status is approved (not pending or blacklisted)
    """

    if request.method == 'POST':
        email = request.form.get('email', '').strip()
        password = request.form.get('password', '')

        staff = Staff.query.filter_by(email=email).first()

        if not staff or not staff.gunjan_check_password(password):
            flash('Invalid email or password', 'error')
            return redirect(url_for('auth.gunjan_login_staff'))

        if staff.gunjan_is_pending():
            flash('Your registration is pending admin approval', 'info')
            return redirect(url_for('auth.gunjan_login_staff'))

        if staff.status == 'blacklisted':
            flash('Your account has been blacklisted', 'error')
            return redirect(url_for('auth.gunjan_login_staff'))

        # Set session
        session['staff_id'] = staff.staff_id
        session['staff_role'] = 'staff'
        session['staff_name'] = staff.name
        session.permanent = True

        flash(f'Welcome {staff.name}!', 'success')
        return redirect(url_for('staff.gunjan_staff_dashboard'))

    return render_template('login_staff.html')


# --------- ADMIN LOGIN ---------
@auth_bp.route('/login-admin', methods=['GET', 'POST'])
def gunjan_login_admin():
    """
    Admin Login (Pre-existing only, no admin registration)
    """

    if request.method == 'POST':
        email = request.form.get('email', '').strip()
        password = request.form.get('password', '')

        # Query for admin user
        admin = User.query.filter_by(email=email, role='admin').first()

        if not admin or not admin.gunjan_check_password(password):
            flash('Invalid admin credentials', 'error')
            return redirect(url_for('auth.gunjan_login_admin'))

        # Set session
        session['user_id'] = admin.user_id
        session['user_role'] = 'admin'
        session['user_name'] = admin.name
        session.permanent = True

        flash(f'Welcome Admin {admin.name}!', 'success')
        return redirect(url_for('admin.gunjan_admin_dashboard'))

    return render_template('login_admin.html')


# --------- LOGOUT ---------
@auth_bp.route('/logout')
def gunjan_logout():
    """Clear session and logout"""
    session.clear()
    flash('You have been logged out', 'success')
    return redirect('/')
