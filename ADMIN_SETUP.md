# Setup Admin User

## Otomatis (Recommended)
Server akan otomatis membuat user admin saat startup jika belum ada:
- **Username/NIP**: `199`
- **Password**: `123`
- **Role**: `admin`

Cukup restart server dan user admin akan otomatis dibuat.

## Manual Setup (Jika Otomatis Gagal)

### Opsi 1: Menggunakan MySQL Client

Jalankan script SQL berikut di MySQL:

```sql
USE ai_chatbot;

-- Pastikan kolom role ada
ALTER TABLE `user` 
ADD COLUMN IF NOT EXISTS role ENUM('user', 'admin') DEFAULT 'user' AFTER prodi;

-- Insert atau update admin user
INSERT INTO `user` (username, email, password, prodi, role)
VALUES ('199', 'admin@telkom.ac.id', '123', 'Admin', 'admin')
ON DUPLICATE KEY UPDATE 
  email = 'admin@telkom.ac.id',
  password = '123',
  prodi = 'Admin',
  role = 'admin';

-- Verifikasi
SELECT id_user, username, email, role FROM `user` WHERE username = '199';
```

### Opsi 2: Menggunakan File SQL

Jalankan file `add_admin_user.sql` atau `migration_add_role.sql` di MySQL:

```bash
mysql -u root -p ai_chatbot < add_admin_user.sql
```

## Troubleshooting

### Masalah: Login dengan 199/123 gagal

**Solusi 1**: Pastikan user admin ada di database
```sql
SELECT * FROM `user` WHERE username = '199';
```

**Solusi 2**: Pastikan password adalah plaintext '123' (bukan hash)
```sql
UPDATE `user` SET password = '123' WHERE username = '199';
```

**Solusi 3**: Pastikan role adalah 'admin'
```sql
UPDATE `user` SET role = 'admin' WHERE username = '199';
```

**Solusi 4**: Restart server untuk trigger auto-create admin user

### Masalah: Kolom role tidak ada

Jalankan:
```sql
ALTER TABLE `user` 
ADD COLUMN role ENUM('user', 'admin') DEFAULT 'user' AFTER prodi;
```

### Verifikasi Setup

Setelah setup, coba login dengan:
- Username: `199`
- Password: `123`

Jika berhasil, Anda akan langsung diarahkan ke halaman Admin Panel.

