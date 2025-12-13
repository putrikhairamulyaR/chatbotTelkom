import React, { useState, useEffect } from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import './StatisticsPage.css';

const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:4000';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d'];

export default function StatisticsPage({ user, onBack, onLogout }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchStatistics();
  }, []);

  const fetchStatistics = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${apiBase}/api/statistics`);
      if (!res.ok) throw new Error('Failed to fetch statistics');
      const data = await res.json();
      setStats(data);
      setError(null);
    } catch (err) {
      console.error('Error fetching statistics:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="stats-container">
        <div className="stats-loading">Memuat data statistik...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="stats-container">
        <div className="stats-error">
          <p>Error: {error}</p>
          <button onClick={fetchStatistics}>Coba Lagi</button>
        </div>
      </div>
    );
  }

  if (!stats) return null;

  // Format hourly data untuk chart (fill missing hours dengan 0)
  const hourlyData = Array.from({ length: 24 }, (_, i) => {
    const existing = stats.hourlyUsage.find(h => h.hour === i);
    return {
      hour: `${i}:00`,
      count: existing ? existing.count : 0,
    };
  });

  // Format daily data
  const dailyData = stats.dailyUsage.map(d => ({
    date: new Date(d.date).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' }),
    count: d.count,
  }));

  return (
    <div className="stats-container">
      <header className="stats-header">
        <div className="stats-header-left">
          <button className="back-btn" onClick={onBack}>
            ← Kembali ke Chat
          </button>
          <h1>Statistik Penggunaan</h1>
        </div>
        <div className="stats-header-right">
          <span className="user-info">
            {user?.username || user?.email}
          </span>
          <button className="logout-btn" onClick={onLogout}>
            Logout
          </button>
        </div>
      </header>

      <div className="stats-content">
        {/* Summary Cards */}
        <div className="stats-summary">
          <div className="stat-card">
            <div className="stat-card-label">Total Pengguna</div>
            <div className="stat-card-value">{stats.summary.totalUsers}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Pengguna Aktif</div>
            <div className="stat-card-value">{stats.summary.uniqueActiveUsers}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Total Pesan</div>
            <div className="stat-card-value">{stats.summary.totalMessages}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Pesan User</div>
            <div className="stat-card-value">{stats.summary.totalUserMessages}</div>
          </div>
        </div>

        {/* Top Topics Chart */}
        <div className="stats-section">
          <h2>Topik Paling Banyak Ditanyakan</h2>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={stats.topTopics || []}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis 
                  dataKey="topic" 
                  angle={-45}
                  textAnchor="end"
                  height={100}
                  interval={0}
                />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="count" fill="#2563eb" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Hourly Usage Chart */}
        <div className="stats-section">
          <h2>Penggunaan per Jam</h2>
          <div className="chart-container">
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={hourlyData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="hour" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="count" stroke="#2563eb" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Daily Usage Chart */}
        {dailyData.length > 0 && (
          <div className="stats-section">
            <h2>Penggunaan 7 Hari Terakhir</h2>
            <div className="chart-container">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={dailyData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="count" fill="#00C49F" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Sentiment Distribution */}
        {stats.sentimentDistribution.length > 0 && (
          <div className="stats-section">
            <h2>Distribusi Sentimen</h2>
            <div className="chart-container">
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={stats.sentimentDistribution}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ label, percent }) => `${label}: ${(percent * 100).toFixed(0)}%`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="count"
                  >
                    {stats.sentimentDistribution.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* Most Active Users */}
        {stats.mostActiveUsers.length > 0 && (
          <div className="stats-section">
            <h2>Pengguna Paling Aktif</h2>
            <div className="table-container">
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>No</th>
                    <th>Username</th>
                    <th>Email</th>
                    <th>Jumlah Pesan</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.mostActiveUsers.map((user, index) => (
                    <tr key={index}>
                      <td>{index + 1}</td>
                      <td>{user.username || '-'}</td>
                      <td>{user.email || '-'}</td>
                      <td>{user.messageCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

