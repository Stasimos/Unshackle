// Progress bar manager for Unshackle
//
// This module centralizes progress reporting in the panel. It allows
// multiple tasks to report their progress and updates a single
// progress bar UI element accordingly. A task is identified by a
// unique taskId; tasks can overlap and the most recently started
// task will own the progress bar.

const taskStates = new Map();
let currentTaskId = null;
let ui = { wrap: null, bar: null, text: null };

/**
 * Attach progress bar elements. Should be called once when the
 * panel is initialized. The progress bar wrapper (wrap) will be
 * shown/hidden automatically; bar is the element whose width is
 * updated; text displays the progress label.
 *
 * @param {{ wrap: HTMLElement, bar: HTMLElement, text: HTMLElement }} elements
 */
export function attachProgress(elements) {
  ui = elements;
  // Hide initial
  if (ui.wrap) ui.wrap.hidden = true;
}

/**
 * Create a new task for reporting progress. Returns an object with
 * helper methods start(), set(), tick() and end(). Each call
 * internally updates the UI for this task and sends a message to
 * other parts of the extension so they can react if necessary.
 *
 * @param {string} taskId Unique identifier for the task
 * @returns {Object} progress API
 */
export function createProgress(taskId) {
  currentTaskId = taskId;
  const state = { done: 0, total: 0, label: '' };
  taskStates.set(taskId, state);
  updateUI(taskId);
  return {
    start(total = 1, label = '') {
      state.done = 0;
      state.total = total;
      state.label = label;
      updateUI(taskId);
    },
    set(done, total = state.total, label = state.label) {
      state.done = done;
      state.total = total;
      state.label = label;
      updateUI(taskId);
    },
    tick(label = state.label) {
      state.done++;
      state.label = label;
      updateUI(taskId);
    },
    end(label = 'Done') {
      state.done = state.total;
      state.label = label;
      updateUI(taskId);
      // Auto-hide after short delay
      setTimeout(() => {
        if (ui.wrap) ui.wrap.hidden = true;
      }, 800);
    }
  };
}

/**
 * Update progress based on an external progress message. This is
 * invoked when receiving progress updates from the content script
 * (via chrome.runtime.sendMessage). The message should include a
 * taskId, done, total and label. If no taskId is provided the
 * message is ignored.
 *
 * @param {Object} msg Progress message
 */
export function updateFromMessage(msg) {
  if (!msg || !msg.taskId) return;
  currentTaskId = msg.taskId;
  const state = taskStates.get(msg.taskId) || { done: 0, total: 0, label: '' };
  if (typeof msg.done === 'number') state.done = msg.done;
  if (typeof msg.total === 'number') state.total = msg.total;
  if (msg.label) state.label = msg.label;
  taskStates.set(msg.taskId, state);
  updateUI(msg.taskId);
}

/**
 * Internal helper to update the UI elements for the current task.
 *
 * @param {string} taskId
 */
function updateUI(taskId) {
  if (!ui.wrap || !ui.bar || !ui.text) return;
  const state = taskStates.get(taskId);
  if (!state) return;
  const { done, total, label } = state;
  if (total <= 0) {
    ui.bar.style.width = '0%';
    ui.text.textContent = label || '';
    ui.wrap.hidden = true;
    return;
  }
  const pct = Math.min(100, Math.round((done / total) * 100));
  ui.bar.style.width = `${pct}%`;
  ui.text.textContent = label || `${pct}%`;
  ui.wrap.hidden = false;
}