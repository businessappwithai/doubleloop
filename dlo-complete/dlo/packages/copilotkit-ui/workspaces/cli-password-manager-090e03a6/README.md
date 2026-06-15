# CLI Password Manager

A secure, command-line password manager with AES-256 encryption, master password protection, and local SQLite storage.

## Features

- **Secure Storage**: AES-256 encryption for all passwords
- **Master Password**: Single master password protects all credentials
- **Password Operations**: Add, view, update, and delete passwords
- **Search**: Find passwords by name or service
- **Backup & Restore**: Export encrypted backups and import from files
- **Local-First**: All data stored locally in encrypted SQLite database
- **Cross-Platform**: Works on Windows, macOS, and Linux

## Requirements

- Python 3.10 or higher
- pip (Python package manager)

## Installation

### From Source

```bash
git clone https://github.com/yourusername/cli-password-manager.git
cd cli-password-manager
pip install -e .
```

### From PyPI

```bash
pip install cli-password-manager
```

## Quick Start

Initialize the password manager with a master password:

```bash
pwm init
```

Add a new password:

```bash
pwm add github --username user@example.com
```

View a password:

```bash
pwm get github
```

List all stored credentials:

```bash
pwm list
```

Search for passwords:

```bash
pwm search github
```

Update a password:

```bash
pwm update github --password newpassword123
```

Delete a password:

```bash
pwm delete github
```

Export encrypted backup:

```bash
pwm export backup.enc
```

Import from backup:

```bash
pwm import backup.enc
```

## Configuration

Configuration is stored in `~/.pwm/config.json`. The database location and encryption settings can be customized:

```json
{
  "db_path": "~/.pwm/passwords.db",
  "master_password_hash": "...",
  "encryption_algorithm": "AES-256"
}
```

## Security Considerations

- **Master Password**: Never share your master password. It is not recoverable if lost.
- **Local Storage**: All data is stored locally on your machine. Be sure to back up your database.
- **Encryption**: Passwords are encrypted using AES-256 in CBC mode with PBKDF2 key derivation.
- **Backups**: Export backups should be stored securely and kept separate from your primary database.

## Database Storage

Passwords are stored in a SQLite database located at `~/.pwm/passwords.db` by default. Each password entry contains:

- Service/Account name
- Username or email
- Encrypted password
- Optional notes
- Creation and update timestamps

## Development

### Setup Development Environment

```bash
git clone https://github.com/yourusername/cli-password-manager.git
cd cli-password-manager
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -e ".[dev]"
```

### Run Tests

```bash
pytest tests/
```

### Run Type Checking

```bash
mypy src/
```

### Format Code

```bash
black src/ tests/
```

## Project Structure

```
cli-password-manager/
├── src/
│   └── pwm/
│       ├── __init__.py
│       ├── cli.py              # Click CLI commands
│       ├── encryption.py       # AES-256 encryption utilities
│       ├── database.py         # SQLite database management
│       ├── config.py           # Configuration handling
│       └── utils.py            # Helper functions
├── tests/
│   ├── test_encryption.py
│   ├── test_database.py
│   └── test_cli.py
├── README.md
├── LICENSE
├── setup.py
├── requirements.txt
└── requirements-dev.txt
```

## Dependencies

- **cryptography**: AES-256 encryption and key derivation
- **Click**: Command-line interface framework
- **SQLite3**: Local database (included with Python)

## API Reference

### Core Classes

#### `PasswordManager`

Main class for managing passwords.

```python
from pwm import PasswordManager

pm = PasswordManager(master_password="your-password")
pm.add("github", "user@example.com", "encrypted-password")
passwords = pm.list_all()
pm.delete("github")
```

#### `Encryption`

Encryption/decryption utilities.

```python
from pwm.encryption import Encryption

cipher = Encryption(master_password="your-password")
encrypted = cipher.encrypt("secret-password")
decrypted = cipher.decrypt(encrypted)
```

#### `Database`

SQLite database wrapper.

```python
from pwm.database import Database

db = Database("~/.pwm/passwords.db")
db.add_password("github", "user@example.com", "encrypted-data")
results = db.search("github")
```

## Troubleshooting

### Forgot Master Password

The master password cannot be recovered. You will need to delete the database and start over:

```bash
rm ~/.pwm/passwords.db
pwm init
```

### Database Locked

If you see "database is locked" errors, ensure only one instance of the password manager is running.

### Permission Denied

Ensure the `~/.pwm/` directory has appropriate permissions:

```bash
chmod 700 ~/.pwm/
chmod 600 ~/.pwm/passwords.db
```

## License

MIT License - see LICENSE file for details

## Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Support

For issues, feature requests, or questions:

- Open an issue on GitHub
- Check existing documentation
- Review security policies before reporting vulnerabilities

## Roadmap

- [ ] Password strength meter
- [ ] Two-factor authentication support
- [ ] Cloud sync (optional, encrypted)
- [ ] Browser extension integration
- [ ] Password generation utility
- [ ] Auto-fill capabilities
- [ ] Audit logs

## Changelog

See CHANGELOG.md for version history and updates.