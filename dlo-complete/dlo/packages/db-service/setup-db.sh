#!/bin/bash
# Setup script for DLO Pipeline Database
# Run this script once to initialize the MariaDB database and tables

set -e

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-dlo}"
DB_PASSWORD="${DB_PASSWORD:-dlopassword}"
DB_NAME="${DB_NAME:-dlo_pipelines}"

echo "[Setup] Creating database and user..."
mysql -u root -e "
CREATE DATABASE IF NOT EXISTS $DB_NAME DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
" || {
  echo "[Setup] WARN: Could not create database/user with root. You may need to run this manually:"
  echo "  mysql -u root -e 'CREATE DATABASE IF NOT EXISTS $DB_NAME;'"
  echo "  mysql -u root -e \"CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';\""
  echo "  mysql -u root -e 'GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;'"
}

echo "[Setup] Creating tables..."
mysql -u "$DB_USER" -p"$DB_PASSWORD" -D "$DB_NAME" < src/schema.sql || {
  echo "[Setup] WARN: Could not create tables. Try manually:"
  echo "  mysql -u $DB_USER -p$DB_PASSWORD -D $DB_NAME < src/schema.sql"
}

echo "[Setup] Testing connection..."
mysql -u "$DB_USER" -p"$DB_PASSWORD" -D "$DB_NAME" -e "SELECT 'Connection OK' AS status;" && \
  echo "[Setup] Success! Database is ready." || \
  echo "[Setup] WARN: Could not verify connection"
