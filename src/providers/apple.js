const { execSync } = require('child_process');

class AppleRemindersProvider {
  constructor() {
    this.name = 'Apple Reminders';
  }

  // Execute AppleScript and return result
  executeAppleScript(script) {
    try {
      const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024
      });
      return result.trim();
    } catch (error) {
      throw new Error(`AppleScript error: ${error.message}`);
    }
  }

  // Get all task lists
  async getLists() {
    const script = `
      tell application "Reminders"
        set output to ""
        repeat with aList in lists
          set output to output & "LIST_START" & linefeed
          set output to output & "ID:" & id of aList & linefeed
          set output to output & "NAME:" & name of aList & linefeed
          set output to output & "LIST_END" & linefeed
        end repeat
        return output
      end tell
    `;
    
    const result = this.executeAppleScript(script);
    return this.parseListsOutput(result);
  }

  // Get tasks from a specific list
  async getTasks(listId) {
    const script = `
      tell application "Reminders"
        set output to ""
        repeat with aList in lists
          if id of aList is "${listId}" then
            repeat with aReminder in reminders of aList
              set output to output & "TASK_START" & linefeed
              set output to output & "ID:" & id of aReminder & linefeed
              set output to output & "NAME:" & name of aReminder & linefeed
              set output to output & "COMPLETED:" & completed of aReminder & linefeed
              try
                if body of aReminder is not missing value then
                  set output to output & "NOTES:" & body of aReminder & linefeed
                end if
              end try
              try
                if due date of aReminder is not missing value then
                  set output to output & "DUE:" & (due date of aReminder as string) & linefeed
                end if
              end try
              set output to output & "TASK_END" & linefeed
            end repeat
            exit repeat
          end if
        end repeat
        return output
      end tell
    `;
    
    const result = this.executeAppleScript(script);
    return this.parseTasksOutput(result);
  }

  // Get task details
  async getTask(listId, taskId) {
    const script = `
      tell application "Reminders"
        set output to ""
        repeat with aList in lists
          if id of aList is "${listId}" then
            repeat with aReminder in reminders of aList
              if id of aReminder is "${taskId}" then
                set output to output & "ID:" & id of aReminder & linefeed
                set output to output & "NAME:" & name of aReminder & linefeed
                set output to output & "COMPLETED:" & completed of aReminder & linefeed
                try
                  if body of aReminder is not missing value then
                    set output to output & "NOTES:" & body of aReminder & linefeed
                  end if
                end try
                try
                  if due date of aReminder is not missing value then
                    set output to output & "DUE:" & (due date of aReminder as string) & linefeed
                  end if
                end try
                try
                  if creation date of aReminder is not missing value then
                    set output to output & "CREATED:" & (creation date of aReminder as string) & linefeed
                  end if
                end try
                return output
              end if
            end repeat
          end if
        end repeat
        return ""
      end tell
    `;
    
    const result = this.executeAppleScript(script);
    if (!result) {
      throw new Error('Task not found');
    }
    return this.parseTaskDetail(result);
  }

  // Mark task as complete
  async completeTask(listId, taskId) {
    const script = `
      tell application "Reminders"
        repeat with aList in lists
          if id of aList is "${listId}" then
            repeat with aReminder in reminders of aList
              if id of aReminder is "${taskId}" then
                set completed of aReminder to true
                return "success"
              end if
            end repeat
          end if
        end repeat
        return "not found"
      end tell
    `;
    
    const result = this.executeAppleScript(script);
    if (result === 'not found') {
      throw new Error('Task not found');
    }
    return { success: true, message: 'Task marked as complete' };
  }

  // Create a new task
  async createTask(listId, taskData) {
    const name = taskData.name || taskData.title || 'Untitled Task';
    const notes = taskData.notes || taskData.description || '';
    
    let script = `
      tell application "Reminders"
        repeat with aList in lists
          if id of aList is "${listId}" then
            set newReminder to make new reminder at aList with properties {name:"${this.escapeString(name)}"}
    `;
    
    if (notes) {
      script += `\n            set body of newReminder to "${this.escapeString(notes)}"`;
    }
    
    script += `
            return id of newReminder
          end if
        end repeat
      end tell
    `;
    
    const result = this.executeAppleScript(script);
    return { id: result, name: name };
  }

  // Helper to escape strings for AppleScript
  escapeString(str) {
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  }

  // Parse lists output
  parseListsOutput(output) {
    if (!output || output.trim() === '') {
      return [];
    }

    const lists = [];
    const listBlocks = output.split('LIST_START');

    for (const block of listBlocks) {
      if (!block.includes('LIST_END')) continue;

      const lines = block.split('\n');
      const list = {};

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('ID:')) {
          list.id = trimmed.substring(3).trim();
        } else if (trimmed.startsWith('NAME:')) {
          list.name = trimmed.substring(5).trim();
        }
      }

      if (list.id && list.name) {
        lists.push(list);
      }
    }

    return lists;
  }

  // Parse tasks output
  parseTasksOutput(output) {
    if (!output || output.trim() === '') {
      return [];
    }

    const tasks = [];
    const taskBlocks = output.split('TASK_START');

    for (const block of taskBlocks) {
      if (!block.includes('TASK_END')) continue;

      const lines = block.split('\n');
      const task = {};

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('ID:')) {
          task.id = trimmed.substring(3).trim();
        } else if (trimmed.startsWith('NAME:')) {
          task.name = trimmed.substring(5).trim();
        } else if (trimmed.startsWith('COMPLETED:')) {
          task.completed = trimmed.substring(10).trim() === 'true';
        } else if (trimmed.startsWith('NOTES:')) {
          task.notes = trimmed.substring(6).trim();
        } else if (trimmed.startsWith('DUE:')) {
          task.dueDate = trimmed.substring(4).trim();
        }
      }

      if (task.id && task.name !== undefined) {
        tasks.push(task);
      }
    }

    return tasks;
  }

  // Parse task detail output
  parseTaskDetail(output) {
    if (!output || output.trim() === '') {
      throw new Error('Task not found');
    }

    const lines = output.split('\n');
    const task = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('ID:')) {
        task.id = trimmed.substring(3).trim();
      } else if (trimmed.startsWith('NAME:')) {
        task.name = trimmed.substring(5).trim();
      } else if (trimmed.startsWith('COMPLETED:')) {
        task.completed = trimmed.substring(10).trim() === 'true';
      } else if (trimmed.startsWith('NOTES:')) {
        task.notes = trimmed.substring(6).trim();
      } else if (trimmed.startsWith('DUE:')) {
        task.dueDate = trimmed.substring(4).trim();
      } else if (trimmed.startsWith('CREATED:')) {
        task.createdDate = trimmed.substring(8).trim();
      }
    }

    return task;
  }
}

module.exports = AppleRemindersProvider;
