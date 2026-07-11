# Trekking Management Application

A web application for managing trekking activities with three roles: **Admin**, **Trek Staff**, and **User (Trekker)**. Built for the App Dev I project.

## Frameworks Used

- **Flask** — application back-end
- **Flask-SQLAlchemy** — ORM over **SQLite** (database is created programmatically via `db.create_all()`, no manual DB creation)
- **Jinja2 + HTML + CSS + Bootstrap 5** — front-end (no JavaScript for core requirements)

## Setup & Run

```bash
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000 in the browser. The SQLite database (`instance/trekking.db`) and the default admin account are created automatically on first run.

### Default Admin Credentials

- Email: `admin@trekking.com`
- Password: `admin123`

(Admin is the pre-existing superuser — there is no admin registration.)

> Note: Bootstrap CSS is loaded from the jsDelivr CDN, so an internet connection is needed for styling (the app itself works fully offline).

## Features

### Authentication
- Separate login for Admin, Trek Staff, and Users
- Self-registration for Staff and Users (staff need admin approval before dashboard access)
- Blacklisted accounts cannot log in

### Admin
- Dashboard with totals (treks, users, staff, bookings) and a CSS-only "popular treks" chart
- Create / edit / approve / close / delete treks
- Approve pending staff, assign approved staff to treks (assigning opens the trek for booking)
- View all users, staff, and bookings (complete historical data)
- Search treks, users, staff by name or ID
- Blacklist / reactivate users and staff

### Trek Staff
- Dashboard with assigned treks and registered users per trek
- Update available slots and trek status (open / closed / completed)
- View participant list for each assigned trek
- Mark trek completed (also completes its active bookings)
- Only the assigned staff member can manage a trek

### User (Trekker)
- Dashboard with available treks, booked treks and trek status
- Browse open treks, search & filter by difficulty and location
- Book treks — with **overbooking prevention**: booking is only allowed if the trek is open, slots are available, the user is not blacklisted and has no duplicate active booking
- Cancel bookings (slot is returned)
- Complete booking history (booked / cancelled / completed)
- Edit profile (name, email, optional password change)

## API Resources (JSON)

| Method | Endpoint            | Description        |
|--------|---------------------|--------------------|
| GET    | `/api/treks`        | List all treks     |
| GET    | `/api/treks/<id>`   | Single trek        |
| GET    | `/api/users`        | List all trekkers  |
| GET    | `/api/bookings`     | List all bookings  |

## Database (ER Overview)

- **user** (user_id PK, name, email unique, password hash, role, status)
- **staff** (staff_id PK, name, email unique, password hash, phone, status, approved_at)
- **trek** (trek_id PK, name, location, difficulty, duration, total_slots, available_slots, assigned_staff_id FK → staff, status, start_date, end_date, description)
- **booking** (booking_id PK, user_id FK → user, trek_id FK → trek, booking_date, status)

Relations: staff 1—N trek, user 1—N booking, trek 1—N booking.

## Folder Structure

```
├── app.py              # Flask app, config, blueprint registration, DB init + admin seeding
├── database.py         # SQLAlchemy models (User, Staff, Trek, Booking)
├── routes/
│   ├── auth.py         # registration / login / logout
│   ├── admin.py        # admin functionality
│   ├── staff.py        # staff functionality
│   ├── user.py         # trekker functionality
│   └── api.py          # JSON API endpoints
├── templates/          # Jinja2 templates (Bootstrap 5)
├── static/css/         # custom CSS
└── requirements.txt
```
