import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';
import { Plus, X, Trash2, GripVertical, MessageSquare } from 'lucide-react';

interface Task {
  id: string;
  title: string;
  client_id: string | null;
  client_name: string | null;
  status: string;
  task_type: string | null;
  comment: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

interface Client { id: string; name: string; }

const STATUSES = [
  { key: 'not_started', label: 'Not started', color: '#64748b', bg: '#1e293b', border: '#334155', dot: '#94a3b8' },
  { key: 'in_progress', label: 'In progress', color: '#3b82f6', bg: '#0c1929', border: '#1e3a5f', dot: '#3b82f6' },
  { key: 'done', label: 'Done', color: '#10b981', bg: '#0a1f17', border: '#14532d', dot: '#10b981' },
];

const emptyForm = { title: '', client_id: '', task_type: '', comment: '', assigned_to: '', status: 'not_started' };

export default function TasksPage() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [employees, setEmployees] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get('/tasks').then((d: Task[]) => setTasks(d)),
      api.get('/clients').then((d: Client[]) => setClients(d)),
      api.get('/users/brief').then((d: { id: string; name: string; role: string }[]) =>
        setEmployees(d.filter(u => u.role === 'admin' || u.role === 'employee'))
      ).catch(() => setEmployees([])),
    ]).finally(() => setLoading(false));
  }, []);

  function openCreate(status: string) {
    setEditTask(null);
    setForm({ ...emptyForm, status });
    setShowModal(true);
  }

  function openEdit(task: Task) {
    setEditTask(task);
    setForm({
      title: task.title,
      client_id: task.client_id || '',
      task_type: task.task_type || '',
      comment: task.comment || '',
      assigned_to: task.assigned_to || '',
      status: task.status,
    });
    setShowModal(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...form,
        client_id: form.client_id || null,
        assigned_to: form.assigned_to || null,
      };
      if (editTask) {
        const updated = await api.patch(`/tasks/${editTask.id}`, payload) as Task;
        setTasks(prev => prev.map(t => t.id === editTask.id ? updated : t));
      } else {
        const created = await api.post('/tasks', payload) as Task;
        setTasks(prev => [created, ...prev]);
      }
      setShowModal(false);
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(taskId: string, newStatus: string) {
    try {
      const updated = await api.patch(`/tasks/${taskId}`, { status: newStatus }) as Task;
      setTasks(prev => prev.map(t => t.id === taskId ? updated : t));
    } catch (err) {
      console.error(err);
    }
  }

  async function handleDelete(taskId: string) {
    if (!confirm('Delete this task?')) return;
    try {
      await api.delete(`/tasks/${taskId}`);
      setTasks(prev => prev.filter(t => t.id !== taskId));
    } catch (err) {
      console.error(err);
    }
  }

  if (loading) return <div style={{ padding: 32, color: '#64748b' }}>Loading tasks...</div>;

  return (
    <div style={{ padding: '24px 32px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9', margin: 0 }}>Tasks</h1>
          <p style={{ fontSize: 13, color: '#64748b', margin: '4px 0 0' }}>{tasks.length} total tasks</p>
        </div>
        <button className="btn btn-primary" onClick={() => openCreate('not_started')}>
          <Plus size={16} /> New Task
        </button>
      </div>

      {/* Kanban Board */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, minHeight: 400 }}>
        {STATUSES.map(col => {
          const colTasks = tasks.filter(t => t.status === col.key);
          return (
            <div key={col.key} style={{
              background: col.bg, borderRadius: 12, border: `1px solid ${col.border}`,
              display: 'flex', flexDirection: 'column', minHeight: 300,
            }}>
              {/* Column header */}
              <div style={{
                padding: '14px 16px', borderBottom: `1px solid ${col.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: col.dot }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{col.label}</span>
                  <span style={{
                    fontSize: 11, fontWeight: 600, color: col.color,
                    background: `${col.color}18`, padding: '2px 8px', borderRadius: 10
                  }}>
                    {colTasks.length}
                  </span>
                </div>
                <button
                  onClick={() => openCreate(col.key)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', color: '#64748b',
                    padding: 4, borderRadius: 6, display: 'flex',
                  }}
                  title="Add task"
                >
                  <Plus size={16} />
                </button>
              </div>

              {/* Tasks list */}
              <div style={{ padding: 8, flex: 1, overflowY: 'auto' }}>
                {colTasks.map(task => (
                  <div
                    key={task.id}
                    onClick={() => openEdit(task)}
                    style={{
                      background: '#0f1729', borderRadius: 10, padding: '12px 14px',
                      marginBottom: 8, cursor: 'pointer', border: '1px solid #1e293b',
                      transition: 'border-color 0.2s',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.borderColor = col.color + '60')}
                    onMouseLeave={e => (e.currentTarget.style.borderColor = '#1e293b')}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginBottom: 6, lineHeight: 1.4 }}>
                      {task.title}
                    </div>
                    {task.client_name && (
                      <div style={{
                        fontSize: 11, color: '#ffa500', background: 'rgba(255,165,0,0.1)',
                        padding: '2px 8px', borderRadius: 6, display: 'inline-block', marginBottom: 4
                      }}>
                        {task.client_name}
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                      {task.task_type && (
                        <span style={{
                          fontSize: 11, color: '#94a3b8', background: '#1e293b',
                          padding: '2px 8px', borderRadius: 6
                        }}>
                          {task.task_type}
                        </span>
                      )}
                      {task.comment && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: '#64748b' }}>
                          <MessageSquare size={11} /> 1
                        </span>
                      )}
                    </div>
                    {task.assigned_to_name && (
                      <div style={{
                        marginTop: 8, fontSize: 11, color: '#64748b',
                        display: 'flex', alignItems: 'center', gap: 6
                      }}>
                        <div style={{
                          width: 18, height: 18, borderRadius: '50%',
                          background: 'linear-gradient(135deg, #ffa500, #ff6b00)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 9, fontWeight: 700, color: '#000', flexShrink: 0,
                        }}>
                          {task.assigned_to_name[0]?.toUpperCase()}
                        </div>
                        {task.assigned_to_name}
                      </div>
                    )}
                  </div>
                ))}
                {colTasks.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '32px 16px', color: '#334155', fontSize: 13 }}>
                    No tasks
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Create / Edit Modal */}
      {showModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setShowModal(false)}>
          <div className="glass-card" style={{ width: '100%', maxWidth: 520, padding: 0 }}
            onClick={e => e.stopPropagation()}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '20px 24px', borderBottom: '1px solid rgba(255,165,0,0.1)'
            }}>
              <h3 style={{ fontSize: 16, fontWeight: 700, color: '#f1f5f9', margin: 0 }}>
                {editTask ? 'Edit Task' : 'New Task'}
              </h3>
              <div style={{ display: 'flex', gap: 8 }}>
                {editTask && (
                  <button
                    onClick={() => { handleDelete(editTask.id); setShowModal(false); }}
                    style={{
                      background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)',
                      color: '#ef4444', cursor: 'pointer', borderRadius: 8, padding: '6px 8px',
                      display: 'flex', alignItems: 'center',
                    }}
                    title="Delete task"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
                <button
                  onClick={() => setShowModal(false)}
                  style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', padding: 4 }}
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            <form onSubmit={handleSave} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Title */}
              <div className="form-group">
                <label className="label">Task Name *</label>
                <input
                  className="input"
                  value={form.title}
                  onChange={e => setForm({ ...form, title: e.target.value })}
                  placeholder="Enter task name..."
                  required
                  autoFocus
                />
              </div>

              {/* Client */}
              <div className="form-group">
                <label className="label">Client</label>
                <select
                  className="input"
                  value={form.client_id}
                  onChange={e => setForm({ ...form, client_id: e.target.value })}
                >
                  <option value="">— No client —</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>

              {/* Status */}
              <div className="form-group">
                <label className="label">Status</label>
                <select
                  className="input"
                  value={form.status}
                  onChange={e => setForm({ ...form, status: e.target.value })}
                >
                  {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>

              {/* Task Type */}
              <div className="form-group">
                <label className="label">Task Type</label>
                <input
                  className="input"
                  value={form.task_type}
                  onChange={e => setForm({ ...form, task_type: e.target.value })}
                  placeholder="e.g. Bug fix, Feature, Setup..."
                />
              </div>

              {/* Assigned To */}
              {employees.length > 0 && (
                <div className="form-group">
                  <label className="label">Assign To</label>
                  <select
                    className="input"
                    value={form.assigned_to}
                    onChange={e => setForm({ ...form, assigned_to: e.target.value })}
                  >
                    <option value="">— Unassigned —</option>
                    {employees.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </div>
              )}

              {/* Comment */}
              <div className="form-group">
                <label className="label">Comment</label>
                <textarea
                  className="input"
                  value={form.comment}
                  onChange={e => setForm({ ...form, comment: e.target.value })}
                  placeholder="Add a comment..."
                  rows={3}
                  style={{ resize: 'vertical' }}
                />
              </div>

              <button className="btn btn-primary" type="submit" disabled={saving} style={{ marginTop: 8 }}>
                {saving ? 'Saving...' : editTask ? 'Update Task' : 'Create Task'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
