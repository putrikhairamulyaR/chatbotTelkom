import React, { useState, useEffect, useMemo } from 'react';
import './AdminPage.css';

const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export default function AdminPage({ user, onLogout }) {
  const PRODI_OPTIONS = [
    {
      label: 'Program Diploma (D3)',
      options: [
        'D3 Teknik Telekomunikasi',
        'D3 Rekayasa Perangkat Lunak Aplikasi',
        'D3 Sistem Informasi',
        'D3 Sistem Informasi Akuntansi',
        'D3 Teknologi Komputer',
        'D3 Digital Marketing',
        'D3 Hospitality & Culinary Art',
        'D3 Manajemen Pemasaran',
        'D3 Teknik Telekomunikasi (Jakarta)',
      ],
    },
    {
      label: 'Program Sarjana Terapan (D4)',
      options: [
        'S1 Terapan Digital Creative Multimedia',
        'S1 Terapan Sistem Informasi Kota Cerdas',
        'S1 Rekayasa Multimedia',
      ],
    },
  ];
  const [activeTab, setActiveTab] = useState('dashboard');
  const [dashboard, setDashboard] = useState(null);
  const [users, setUsers] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [resources, setResources] = useState([]);
  // Users: search term
  const [userSearch, setUserSearch] = useState('');
  // Audit: sort control
  const [auditSortBy, setAuditSortBy] = useState('timestamp'); // 'timestamp' | 'user'
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [embedding, setEmbedding] = useState({});
  const [uploadTopic, setUploadTopic] = useState('');
  const [uploadSubtopic, setUploadSubtopic] = useState('');
  const [showUploadPanel, setShowUploadPanel] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);

  const handleSubmitUpload = async () => {
    try {
      if (!selectedFile) {
        showToast('Pilih file terlebih dahulu', 'error');
        return;
      }
      const name = selectedFile.name.toLowerCase();
      if (!name.endsWith('.pdf') && !name.endsWith('.txt') && !name.endsWith('.md')) {
        showToast('Hanya file PDF, TXT, dan MD yang diizinkan', 'error', 5000);
        return;
      }

      setUploading(true);
      const formData = new FormData();
      formData.append('document', selectedFile);
      formData.append('filename', selectedFile.name);
      if (uploadTopic) formData.append('topic', uploadTopic);
      if (uploadSubtopic) formData.append('subtopic', uploadSubtopic);

      const res = await fetch(`${apiBase}/api/admin/resources`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to upload file' }));
        throw new Error(err.error || 'Failed to upload file');
      }

      const data = await res.json();
      showToast(data.message || 'File berhasil diupload', 'success');
      setSelectedFile(null);
      // Optionally close panel after upload
      // setShowUploadPanel(false);
      fetchResources();
    } catch (err) {
      showToast('Error: ' + err.message, 'error', 5000);
    } finally {
      setUploading(false);
    }
  };
  const [savingUser, setSavingUser] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState(null);
  const [deletingResourceName, setDeletingResourceName] = useState(null);

  // Toast notification (popup info)
  const [toast, setToast] = useState(null);
  const showToast = (message, type = 'info', duration = 3000) => {
    setToast({ message, type });
    if (duration > 0) setTimeout(() => setToast(null), duration);
  };

  // Confirm modal state
  const [confirmModal, setConfirmModal] = useState({ open: false });
  const openConfirm = (opts) => setConfirmModal({ open: true, ...opts });
  const closeConfirm = () => setConfirmModal({ open: false });

  // User management form state
  const [showUserForm, setShowUserForm] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [userForm, setUserForm] = useState({ username: '', email: '', password: '', prodi: '', role: 'user' });

  useEffect(() => {
    // Check if user is properly authenticated
    if (!user || !user.id_user) {
      console.error('[AdminPage] User not authenticated:', user);
      setError('User not authenticated. Please login again.');
      return;
    }

    console.log('[AdminPage] Loading tab:', activeTab, 'for user:', user.id_user);
    
    if (activeTab === 'dashboard') {
      fetchDashboard();
    } else if (activeTab === 'users') {
      fetchUsers();
    } else if (activeTab === 'audit') {
      fetchAuditLogs();
    } else if (activeTab === 'resources') {
      fetchResources();
    }
  }, [activeTab, user]);

  const fetchDashboard = async () => {
    try {
      setLoading(true);
      if (!user || !user.id_user) {
        throw new Error('User not authenticated. Please login again.');
      }
      const res = await fetch(`${apiBase}/api/admin/dashboard`, {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Failed to fetch dashboard' }));
        throw new Error(errorData.error || `HTTP ${res.status}: Failed to fetch dashboard`);
      }
      const data = await res.json();
      setDashboard(data);
      setError(null);
    } catch (err) {
      console.error('Error fetching dashboard:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ===== Derived data =====
  const normalized = (v) => (v == null ? '' : String(v).toLowerCase());
  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) =>
      normalized(u.username).includes(q) ||
      normalized(u.email).includes(q) ||
      normalized(u.nim).includes(q) ||
      normalized(u.prodi).includes(q) ||
      normalized(u.role).includes(q)
    );
  }, [users, userSearch]);

  const sortedAuditLogs = useMemo(() => {
    const rows = [...auditLogs];
    if (auditSortBy === 'timestamp') {
      rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else if (auditSortBy === 'user') {
      const key = (x) => (x.username || x.email || String(x.id_user || '')).toString().toLowerCase();
      rows.sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        if (ka < kb) return -1;
        if (ka > kb) return 1;
        return 0;
      });
    }
    return rows;
  }, [auditLogs, auditSortBy]);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      if (!user || !user.id_user) {
        throw new Error('User not authenticated. Please login again.');
      }
      const res = await fetch(`${apiBase}/api/admin/users`, {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Failed to fetch users' }));
        throw new Error(errorData.error || `HTTP ${res.status}: Failed to fetch users`);
      }
      const data = await res.json();
      setUsers(data.users || []);
      setError(null);
    } catch (err) {
      console.error('Error fetching users:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchAuditLogs = async () => {
    try {
      setLoading(true);
      if (!user || !user.id_user) {
        throw new Error('User not authenticated. Please login again.');
      }
      const res = await fetch(`${apiBase}/api/admin/audit-log?limit=100`, {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Failed to fetch audit logs' }));
        throw new Error(errorData.error || `HTTP ${res.status}: Failed to fetch audit logs`);
      }
      const data = await res.json();
      setAuditLogs(data.logs || []);
      setError(null);
    } catch (err) {
      console.error('Error fetching audit logs:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchResources = async () => {
    try {
      setLoading(true);
      if (!user || !user.id_user) {
        throw new Error('User not authenticated. Please login again.');
      }
      const res = await fetch(`${apiBase}/api/admin/resources`, {
        headers: { Authorization: `Bearer ${user.token}` },
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: 'Failed to fetch resources' }));
        throw new Error(errorData.error || `HTTP ${res.status}: Failed to fetch resources`);
      }
      const data = await res.json();
      setResources(data.files || []);
      setError(null);
    } catch (err) {
      console.error('Error fetching resources:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    try {
      setSavingUser(true);
      const res = await fetch(`${apiBase}/api/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ ...userForm }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to add user');
      }
      setShowUserForm(false);
      setUserForm({ username: '', nim: '', email: '', password: '', prodi: '', role: 'user' });
      fetchUsers();
      showToast('User berhasil ditambahkan', 'success');
    } catch (err) {
      showToast('Error: ' + err.message, 'error', 5000);
    } finally {
      setSavingUser(false);
    }
  };

  const handleEditUser = async (e) => {
    e.preventDefault();
    try {
      setSavingUser(true);
      const res = await fetch(`${apiBase}/api/admin/users/${editingUser.id_user}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ ...userForm }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to update user');
      }
      setEditingUser(null);
      setShowUserForm(false);
      setUserForm({ username: '', nim: '', email: '', password: '', prodi: '', role: 'user' });
      fetchUsers();
      showToast('User berhasil diupdate', 'success');
    } catch (err) {
      showToast('Error: ' + err.message, 'error', 5000);
    } finally {
      setSavingUser(false);
    }
  };

  const handleDeleteUser = (id) => {
    openConfirm({
      title: 'Konfirmasi Hapus User',
      message: 'Apakah Anda yakin ingin menghapus user ini? Tindakan tidak dapat dibatalkan.',
      confirmText: 'Hapus',
      cancelText: 'Batal',
      onConfirm: async () => {
        try {
          setDeletingUserId(id);
          const res = await fetch(`${apiBase}/api/admin/users/${id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${user.token}` },
          });
          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to delete user');
          }
          fetchUsers();
          showToast('User berhasil dihapus', 'success');
        } catch (err) {
          showToast('Error: ' + err.message, 'error', 5000);
        } finally {
          setDeletingUserId(null);
        }
      },
    });
  };

  const handleDeleteResource = (filename) => {
    openConfirm({
      title: 'Konfirmasi Hapus Dokumen',
      message: `Apakah Anda yakin ingin menghapus dokumen "${filename}"?`,
      confirmText: 'Hapus',
      cancelText: 'Batal',
      onConfirm: async () => {
        try {
          setDeletingResourceName(filename);
          const res = await fetch(`${apiBase}/api/admin/resources/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${user.token}` },
          });
          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to delete resource');
          }
          fetchResources();
          showToast('Dokumen berhasil dihapus', 'success');
        } catch (err) {
          showToast('Error: ' + err.message, 'error', 5000);
        } finally {
          setDeletingResourceName(null);
        }
      },
    });
  };

  const handleUploadFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!['.pdf', '.txt', '.md'].includes(file.name.toLowerCase().slice(-4))) {
      showToast('Hanya file PDF, TXT, dan MD yang diizinkan', 'error', 5000);
      return;
    }

    try {
      setUploading(true);
      const formData = new FormData();
      formData.append('document', file);
      formData.append('filename', file.name);
      if (uploadTopic) formData.append('topic', uploadTopic);
      if (uploadSubtopic) formData.append('subtopic', uploadSubtopic);

      const res = await fetch(`${apiBase}/api/admin/resources`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.token}` },
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to upload file');
      }

      const data = await res.json();
      showToast(data.message || 'File berhasil diupload', 'success');
      fetchResources();
      e.target.value = ''; // Reset input
      // keep topic/subtopic for next file, or clear if you prefer
    } catch (err) {
      showToast('Error: ' + err.message, 'error', 5000);
    } finally {
      setUploading(false);
    }
  };

  const handleEmbedResource = (filename) => {
    openConfirm({
      title: 'Embed Dokumen ke Qdrant',
      message: `Apakah Anda yakin ingin meng-embed dokumen "${filename}" ke Qdrant?`,
      confirmText: 'Embed',
      cancelText: 'Batal',
      onConfirm: async () => {
        try {
          setEmbedding({ ...embedding, [filename]: true });
          const res = await fetch(`${apiBase}/api/admin/resources/${encodeURIComponent(filename)}/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}` },
            body: JSON.stringify({}),
          });

          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to embed resource');
          }

          const data = await res.json();
          showToast(data.message || `Berhasil meng-embed ${data.chunks} chunks ke Qdrant`, 'success');
          fetchResources();
        } catch (err) {
          showToast('Error: ' + err.message, 'error', 5000);
        } finally {
          setEmbedding({ ...embedding, [filename]: false });
        }
      },
    });
  };

  const openEditUser = (u) => {
    setEditingUser(u);
    setUserForm({
      username: u.username || '',
      nim: u.nim || '',
      email: u.email || '',
      password: '',
      prodi: u.prodi || '',
      role: u.role || 'user',
    });
    setShowUserForm(true);
  };

  const closeUserForm = () => {
    setShowUserForm(false);
    setEditingUser(null);
    setUserForm({ username: '', nim: '', email: '', password: '', prodi: '', role: 'user' });
  };

  return (<>
    <div className="admin-container">
      <header className="admin-header">
        <h1>Admin Panel</h1>
        <div className="admin-header-right">
          <span className="user-info">{user?.username || user?.email}</span>
          <button className="logout-btn" onClick={onLogout}>
            Logout
          </button>
        </div>
      </header>

      <div className="admin-content">
        <nav className="admin-nav">
          <button
            className={activeTab === 'dashboard' ? 'active' : ''}
            onClick={() => setActiveTab('dashboard')}
          >
            Dashboard
          </button>
          <button
            className={activeTab === 'users' ? 'active' : ''}
            onClick={() => setActiveTab('users')}
          >
            Pengaturan Data (User)
          </button>
          <button
            className={activeTab === 'audit' ? 'active' : ''}
            onClick={() => setActiveTab('audit')}
          >
            Audit Log
          </button>
          <button
            className={activeTab === 'resources' ? 'active' : ''}
            onClick={() => setActiveTab('resources')}
          >
            Pengaturan Sumber Daya
          </button>
        </nav>

        <div className="admin-main">
          {error && (
            <div className="error-message">
              <strong>Error:</strong> {error}
              {error.includes('401') || error.includes('Authentication') ? (
                <div style={{ marginTop: '8px' }}>
                  <button 
                    className="btn-primary" 
                    onClick={() => window.location.reload()}
                    style={{ fontSize: '14px', padding: '6px 12px' }}
                  >
                    Refresh & Login Ulang
                  </button>
                </div>
              ) : null}
            </div>
          )}

          {loading && <div className="loading">Memuat data...</div>}

          {!user || !user.id_user ? (
            <div className="error-message">
              <strong>Error:</strong> User tidak ter-authenticate. Silakan login ulang.
            </div>
          ) : null}

          {activeTab === 'dashboard' && dashboard && (
            <div className="dashboard-content">
              <h2>Dashboard Data - Statistik Penggunaan</h2>
              
              {/* Summary Cards */}
              <div className="stats-grid">
                <div className="stat-card">
                  <h3>Total Users</h3>
                  <p className="stat-value">{dashboard.totalUsers}</p>
                </div>
                <div className="stat-card">
                  <h3>Total Messages</h3>
                  <p className="stat-value">{dashboard.totalMessages}</p>
                </div>
                <div className="stat-card">
                  <h3>Active Users (7 hari)</h3>
                  <p className="stat-value">{dashboard.activeUsers}</p>
                </div>
                <div className="stat-card">
                  <h3>Dokumen di Qdrant</h3>
                  <p className="stat-value">{dashboard.qdrantStats?.uniqueFiles || 0}</p>
                </div>
                {dashboard.peakHour && (
                  <div className="stat-card highlight">
                    <h3>Jam Puncak Penggunaan</h3>
                    <p className="stat-value">{dashboard.peakHour.hourLabel}</p>
                    <p className="stat-subtitle">{dashboard.peakHour.count} messages</p>
                  </div>
                )}
              </div>

              {/* Kepuasan & Sentimen Pengguna */}
              {dashboard.sentimentOverview && (
                <div className="dashboard-section">
                  <h3>😊 Kepuasan & Sentimen Pengguna</h3>
                  <p className="section-description">Ringkasan kepuasan berdasarkan sentimen pesan pengguna</p>
                  <div className="stats-grid">
                    <div className="stat-card">
                      <h3>Satisfaction Rate</h3>
                      <p className="stat-value">{dashboard.sentimentOverview.satisfactionRate}%</p>
                      <p className="stat-subtitle">Positif / (Positif + Negatif)</p>
                    </div>
                    <div className="stat-card">
                      <h3>Avg Sentiment Score</h3>
                      <p className="stat-value">{dashboard.sentimentOverview.avgSentimentScore}</p>
                      <p className="stat-subtitle">Skala -1 .. 1</p>
                    </div>
                    <div className="stat-card">
                      <h3>Positive</h3>
                      <p className="stat-value">{dashboard.sentimentOverview.positive}</p>
                    </div>
                    <div className="stat-card">
                      <h3>Neutral</h3>
                      <p className="stat-value">{dashboard.sentimentOverview.neutral}</p>
                    </div>
                    <div className="stat-card">
                      <h3>Negative</h3>
                      <p className="stat-value">{dashboard.sentimentOverview.negative}</p>
                    </div>
                  </div>

                  {/* Tren Sentimen Harian */}
                  {dashboard.sentimentDaily && dashboard.sentimentDaily.length > 0 && (
                    <div className="dashboard-subsection" style={{ marginTop: '16px' }}>
                      <h4>📅 Tren Sentimen Harian (14 hari)</h4>
                      <div className="daily-messages">
                        {dashboard.sentimentDaily.map((d, i) => (
                          <div key={i} className="daily-item">
                            <span>{new Date(d.date).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                            <span>
                              <strong>+{d.positive}</strong> / <strong>{d.neutral}</strong> / <strong>-{d.negative}</strong>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Umpan Balik Negatif Terbaru */}
                  {dashboard.recentNegativeFeedback && dashboard.recentNegativeFeedback.length > 0 && (
                    <div className="dashboard-subsection" style={{ marginTop: '16px' }}>
                      <h4>⚠ Umpan Balik Negatif (Terbaru)</h4>
                      <ul className="topics-list" style={{ gap: '8px' }}>
                        {dashboard.recentNegativeFeedback.map((f, idx) => (
                          <li key={idx} className="topic-item" style={{ display: 'flex', alignItems: 'center' }}>
                            <div className="topic-rank">#{idx + 1}</div>
                            <div className="topic-content">
                              <div className="topic-name" style={{ fontWeight: 500 }}>
                                {new Date(f.created_at).toLocaleString('id-ID')}
                              </div>
                              <div className="topic-count" style={{ whiteSpace: 'pre-wrap' }}>{f.message}</div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Penggunaan per Jam */}
              {dashboard.hourlyUsage && dashboard.hourlyUsage.length > 0 && (
                <div className="dashboard-section">
                  <h3>📊 Penggunaan Tertinggi per Jam</h3>
                  <p className="section-description">
                    {dashboard.peakHour 
                      ? `Jam dengan penggunaan tertinggi: ${dashboard.peakHour.hourLabel} dengan ${dashboard.peakHour.count} messages`
                      : 'Statistik penggunaan per jam dalam 24 jam'}
                  </p>
                  <div className="hourly-chart">
                    {dashboard.hourlyUsage.map((h) => {
                      const maxCount = Math.max(...dashboard.hourlyUsage.map(hu => hu.count));
                      const percentage = maxCount > 0 ? (h.count / maxCount) * 100 : 0;
                      const isPeak = dashboard.peakHour && h.hour === dashboard.peakHour.hour;
                      return (
                        <div key={h.hour} className={`hourly-bar ${isPeak ? 'peak' : ''}`}>
                          <div className="hourly-bar-fill" style={{ height: `${percentage}%` }}>
                            <span className="hourly-count">{h.count}</span>
                          </div>
                          <div className="hourly-label">{h.hourLabel}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Top Topics */}
              {dashboard.topTopics && dashboard.topTopics.length > 0 && (
                <div className="dashboard-section">
                  <h3>🔥 Topik Paling Banyak Ditanyakan</h3>
                  <p className="section-description">Top 10 topik yang paling sering ditanyakan oleh user</p>
                  <div className="topics-list">
                    {dashboard.topTopics.map((topic, idx) => (
                      <div key={idx} className="topic-item">
                        <div className="topic-rank">#{idx + 1}</div>
                        <div className="topic-content">
                          <div className="topic-name">{topic.topic}</div>
                          <div className="topic-count">{topic.count} kali ditanyakan</div>
                        </div>
                        <div className="topic-bar">
                          <div 
                            className="topic-bar-fill" 
                            style={{ 
                              width: `${(topic.count / dashboard.topTopics[0].count) * 100}%` 
                            }}
                          ></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Most Accessed Documents */}
              {dashboard.mostAccessedDocs && dashboard.mostAccessedDocs.length > 0 && (
                <div className="dashboard-section">
                  <h3>📄 Dokumen Paling Banyak Diakses</h3>
                  <p className="section-description">Dokumen yang paling sering diakses dari Qdrant</p>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Nama Dokumen</th>
                        <th>Jumlah Akses</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard.mostAccessedDocs.map((doc, idx) => (
                        <tr key={idx}>
                          <td>
                            <span className="rank-badge">#{idx + 1}</span>
                          </td>
                          <td className="doc-name">{doc.filename}</td>
                          <td>
                            <strong>{doc.accessCount}</strong> chunks
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Top Users */}
              {dashboard.topUsers && dashboard.topUsers.length > 0 && (
                <div className="dashboard-section">
                  <h3>👥 User dengan Penggunaan Tertinggi</h3>
                  <p className="section-description">Top 10 user yang paling aktif menggunakan chatbot</p>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Username</th>
                        <th>Email</th>
                        <th>Total Messages</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard.topUsers.map((u, idx) => (
                        <tr key={u.id_user}>
                          <td>
                            <span className="rank-badge">#{idx + 1}</span>
                          </td>
                          <td>{u.username}</td>
                          <td>{u.email}</td>
                          <td><strong>{u.message_count}</strong></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Daily Messages */}
              {dashboard.dailyMessages && dashboard.dailyMessages.length > 0 && (
                <div className="dashboard-section">
                  <h3>📅 Messages per Hari (7 hari terakhir)</h3>
                  <div className="daily-messages">
                    {dashboard.dailyMessages.map((d, i) => (
                      <div key={i} className="daily-item">
                        <span>{new Date(d.date).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
                        <span><strong>{d.count}</strong> messages</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'users' && (
            <div className="users-content">
              <div className="section-header">
                <h2>Pengaturan Data (User Management)</h2>
                <button className="btn-primary" onClick={() => setShowUserForm(true)}>
                  + Tambah User
                </button>
              </div>

              <div className="section-controls" style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', marginBottom: 12 }}>
                <input
                  type="text"
                  placeholder="Cari user (username, email, NIM, prodi, role)"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  style={{ padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 6, minWidth: 260 }}
                />
              </div>

              {showUserForm && (
                <div className="modal-overlay" onClick={closeUserForm}>
                  <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                    <h3>{editingUser ? 'Edit User' : 'Tambah User Baru'}</h3>
                    <form onSubmit={editingUser ? handleEditUser : handleAddUser}>
                      <div className="form-group">
                        <label>Username *</label>
                        <input
                          type="text"
                          value={userForm.username}
                          onChange={(e) => setUserForm({ ...userForm, username: e.target.value })}
                          required
                        />
                      </div>
                      <div className="form-group">
                        <label>NIM *</label>
                        <input
                          type="text"
                          value={userForm.nim || ''}
                          onChange={(e) => setUserForm({ ...userForm, nim: e.target.value })}
                          required={!editingUser}
                        />
                      </div>
                      <div className="form-group">
                        <label>Email</label>
                        <input
                          type="email"
                          value={userForm.email}
                          onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                        />
                      </div>
                      <div className="form-group">
                        <label>{editingUser ? 'Password (kosongkan jika tidak diubah)' : 'Password *'}</label>
                        <input
                          type="password"
                          value={userForm.password}
                          onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                          required={!editingUser}
                        />
                      </div>
                      <div className="form-group">
                        <label>Prodi</label>
                        <select
                          value={userForm.prodi || ''}
                          onChange={(e) => setUserForm({ ...userForm, prodi: e.target.value })}
                        >
                          <option value="">-- Pilih Program Studi --</option>
                          {PRODI_OPTIONS.map((grp) => (
                            <optgroup key={grp.label} label={grp.label}>
                              {grp.options.map((opt) => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </div>
                      <div className="form-group">
                        <label>Role</label>
                        <select
                          value={userForm.role}
                          onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
                        >
                          <option value="user">User</option>
                          <option value="admin">Admin</option>
                        </select>
                      </div>
                      <div className="form-actions">
                        <button type="submit" className="btn-primary" disabled={savingUser}>
                          {savingUser ? (editingUser ? 'Mengupdate...' : 'Menambah...') : (editingUser ? 'Update' : 'Tambah')}
                        </button>
                        <button type="button" className="btn-secondary" onClick={closeUserForm}>
                          Batal
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              )}

              <table className="data-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Username</th>
                    <th>NIM</th>
                    <th>Email</th>
                    <th>Prodi</th>
                    <th>Role</th>
                    <th>Created At</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((u) => (
                    <tr key={u.id_user}>
                      <td>{u.id_user}</td>
                      <td>{u.username}</td>
                      <td>{u.nim || '-'}</td>
                      <td>{u.email}</td>
                      <td>{u.prodi || '-'}</td>
                      <td>
                        <span className={`role-badge ${u.role}`}>{u.role}</span>
                      </td>
                      <td>{new Date(u.created_at).toLocaleDateString('id-ID')}</td>
                      <td>
                        <button className="btn-edit" onClick={() => openEditUser(u)}>
                          Edit
                        </button>
                        <button
                          className="btn-delete"
                          onClick={() => handleDeleteUser(u.id_user)}
                          disabled={u.id_user === user.id_user || deletingUserId === u.id_user}
                        >
                          {deletingUserId === u.id_user ? 'Menghapus...' : 'Hapus'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'audit' && (
            <div className="audit-content">
              <h2>Audit Log User</h2>
              <div className="audit-info" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <p style={{ margin: 0 }}>Menampilkan log aktivitas admin dan perubahan data</p>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label htmlFor="audit-sort" style={{ color: '#475569' }}>Sort:</label>
                  <select
                    id="audit-sort"
                    value={auditSortBy}
                    onChange={(e) => setAuditSortBy(e.target.value)}
                    style={{ padding: '6px 10px', border: '1px solid #cbd5e1', borderRadius: 6 }}
                  >
                    <option value="timestamp">Timestamp</option>
                    <option value="user">User (A-Z)</option>
                  </select>
                </div>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>User</th>
                    <th>Action</th>
                    <th>Resource Type</th>
                    <th>Details</th>
                    <th>Timestamp</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAuditLogs.map((log) => (
                    <tr key={log.id}>
                      <td>{log.id}</td>
                      <td>{log.username || log.email || log.id_user}</td>
                      <td>
                        <span className="action-badge">{log.action}</span>
                      </td>
                      <td>{log.resource_type || '-'}</td>
                      <td className="details-cell">
                        {log.details ? (
                          <details>
                            <summary>View</summary>
                            <pre>{JSON.stringify(JSON.parse(log.details), null, 2)}</pre>
                          </details>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td>{new Date(log.created_at).toLocaleString('id-ID')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'resources' && (
            <div className="resources-content">
              <div className="section-header">
                <h2>Pengaturan Sumber Daya</h2>
                <button className="btn-primary" onClick={() => setShowUploadPanel(true)}>
                  + Upload Dokumen
                </button>
              </div>

              {showUploadPanel && (
                <div className="modal-overlay" onClick={() => setShowUploadPanel(false)}>
                  <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                    <h3>Upload Dokumen Baru</h3>
                    <div
                      className="upload-drop"
                      style={{
                        border: '2px dashed #cbd5e1',
                        borderRadius: 10,
                        padding: 20,
                        background: '#f8fafc',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 16,
                        cursor: 'pointer',
                        marginBottom: 16,
                      }}
                      onClick={() => document.getElementById('file-input-hidden')?.click()}
                    >
                      <div style={{ fontSize: 32 }}>📄</div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontWeight: 600, color: '#111827' }}>Pilih dokumen untuk diupload</div>
                        <div style={{ color: '#64748b', fontSize: 13, marginTop: 4 }}>Format: PDF, TXT, MD</div>
                        {selectedFile && (
                          <div style={{ marginTop: 8, color: '#2563eb', fontWeight: 500 }}>✓ Dipilih: {selectedFile.name}</div>
                        )}
                      </div>
                      <label className="btn-primary" style={{ padding: '8px 16px', marginBottom: 0 }}>
                        <input
                          id="file-input-hidden"
                          type="file"
                          accept=".pdf,.txt,.md"
                          onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                          disabled={uploading}
                          style={{ display: 'none' }}
                        />
                        Pilih File
                      </label>
                    </div>

                    <div className="form-group">
                      <label>Topik (opsional)</label>
                      <input
                        type="text"
                        placeholder="Masukkan topik dokumen"
                        value={uploadTopic}
                        onChange={(e) => setUploadTopic(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>Sub Topik (opsional)</label>
                      <input
                        type="text"
                        placeholder="Masukkan sub topik dokumen"
                        value={uploadSubtopic}
                        onChange={(e) => setUploadSubtopic(e.target.value)}
                      />
                    </div>

                    <div className="form-actions">
                      <button
                        className="btn-primary"
                        onClick={handleSubmitUpload}
                        disabled={uploading || !selectedFile}
                      >
                        {uploading ? 'Mengunggah...' : 'Upload'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          setShowUploadPanel(false);
                          setSelectedFile(null);
                          setUploadTopic('');
                          setUploadSubtopic('');
                        }}
                        disabled={uploading}
                      >
                        Batal
                      </button>
                    </div>
                  </div>
                </div>
              )}
              <p className="info-text">
                Upload dokumen PDF/TXT/MD dan embed ke Qdrant untuk digunakan dalam chatbot.
              </p>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Filename</th>
                    <th>Status</th>
                    <th>Chunks</th>
                    <th>Topik</th>
                    <th>Sub Topik</th>
                    <th>Size</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {resources.map((file, i) => (
                    <tr key={i}>
                      <td className="doc-name">{file.filename}</td>
                      <td>
                        {file.isEmbedded ? (
                          <span className="status-badge embedded">✓ Embedded</span>
                        ) : (
                          <span className="status-badge not-embedded">⚠ Belum di-embed</span>
                        )}
                      </td>
                      <td>{file.chunks || 0}</td>
                      <td>{file.topic || '-'}</td>
                      <td>{file.subtopic || '-'}</td>
                      <td>{file.size ? `${(file.size / 1024).toFixed(1)} KB` : '-'}</td>
                      <td>
                        <div className="action-buttons">
                          {!file.isEmbedded && (
                            <button
                              className="btn-embed"
                              onClick={() => handleEmbedResource(file.filename)}
                              disabled={embedding[file.filename]}
                            >
                              {embedding[file.filename] ? 'Embedding...' : 'Embed ke Qdrant'}
                            </button>
                          )}
                          <button
                            className="btn-delete"
                            onClick={() => handleDeleteResource(file.filename)}
                          >
                            {deletingResourceName === file.filename ? 'Menghapus...' : 'Hapus'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {resources.length === 0 && !loading && (
                <p className="empty-message">Tidak ada dokumen yang tersimpan. Upload dokumen untuk memulai.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    {/* Confirm Modal */}
    {confirmModal.open && (
      <div className="modal-overlay" onClick={closeConfirm}>
        <div className="modal-content" onClick={(e) => e.stopPropagation()}>
          <h3>{confirmModal.title || 'Konfirmasi'}</h3>
          <p style={{ marginTop: '8px' }}>{confirmModal.message || 'Lanjutkan tindakan ini?'}</p>
          <div className="form-actions" style={{ marginTop: '12px' }}>
            <button className="btn-primary" onClick={() => { const fn = confirmModal.onConfirm; closeConfirm(); fn && fn(); }}>
              {confirmModal.confirmText || 'Ya'}
            </button>
            <button className="btn-secondary" onClick={() => { const fn = confirmModal.onCancel; closeConfirm(); fn && fn(); }}>
              {confirmModal.cancelText || 'Batal'}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* Toast Notification */}
    {toast && (
      <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999 }}>
        <div style={{ background: toast.type === 'success' ? '#12B981' : toast.type === 'error' ? '#F43F5E' : '#334155', color: '#fff', padding: '10px 14px', borderRadius: 8, boxShadow: '0 6px 16px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span>{toast.message}</span>
          <button onClick={() => setToast(null)} style={{ background: 'transparent', color: '#fff', border: 'none', fontSize: 18, lineHeight: 1, cursor: 'pointer' }}>×</button>
        </div>
      </div>
    )}
  </>);
}

