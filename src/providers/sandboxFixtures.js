// Static seed data for the sandbox provider. Dates are computed relative to
// "today" at require-time so overdue/future-due tasks stay meaningfully
// classified (Now/Next/Later) no matter when the sandbox is used.
function isoDate(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function buildFixtures() {
  return {
    lists: [
      { id: 'sandbox-list-work', name: 'Work', updated: new Date().toISOString() },
      { id: 'sandbox-list-personal', name: 'Personal', updated: new Date().toISOString() },
      { id: 'sandbox-list-someday', name: 'Someday', updated: new Date().toISOString() }
    ],
    tasks: {
      'sandbox-list-work': [
        { id: 'sandbox-task-1', name: 'Reply to client escalation', completed: false, priority: 'high', notes: 'Overdue and high priority — lands in Now.', dueDate: isoDate(-2), updated: new Date().toISOString(), position: '1' },
        { id: 'sandbox-task-2', name: 'Prep Q3 roadmap doc', completed: false, priority: 'normal', notes: 'Due later this week — lands in Next.', dueDate: isoDate(4), updated: new Date().toISOString(), position: '2' },
        { id: 'sandbox-task-3', name: 'Archive old project files', completed: false, priority: 'low', notes: 'No due date — lands in Later.', dueDate: null, updated: new Date().toISOString(), position: '3' },
        { id: 'sandbox-task-4', name: 'Approve expense report', completed: true, priority: 'normal', notes: 'Already done.', dueDate: isoDate(-5), updated: new Date().toISOString(), position: '4' }
      ],
      'sandbox-list-personal': [
        { id: 'sandbox-task-5', name: 'Renew passport', completed: false, priority: 'high', notes: 'Overdue — lands in Now.', dueDate: isoDate(-1), updated: new Date().toISOString(), position: '1' },
        { id: 'sandbox-task-6', name: 'Book dentist appointment', completed: false, priority: 'normal', notes: 'Due next week — lands in Next.', dueDate: isoDate(6), updated: new Date().toISOString(), position: '2' },
        { id: 'sandbox-task-7', name: 'Read that book', completed: false, priority: 'low', notes: 'No due date — lands in Later.', dueDate: null, updated: new Date().toISOString(), position: '3' }
      ],
      'sandbox-list-someday': [
        { id: 'sandbox-task-8', name: 'Learn woodworking', completed: false, priority: 'low', notes: 'Someday/maybe — lands in Later.', dueDate: null, updated: new Date().toISOString(), position: '1' },
        { id: 'sandbox-task-9', name: 'Plan a sabbatical', completed: false, priority: 'low', notes: 'Someday/maybe — lands in Later.', dueDate: null, updated: new Date().toISOString(), position: '2' }
      ]
    }
  };
}

module.exports = { buildFixtures };
