'use client';

export const SELECTED_PROJECT_KEY = 'organism.selectedProject';
export const SELECTED_PROJECT_EVENT = 'organism:selected-project';

export function getInitialSelectedProject(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(SELECTED_PROJECT_KEY) ?? '';
  } catch {
    return '';
  }
}

export function persistSelectedProject(projectId: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (projectId) {
      window.localStorage.setItem(SELECTED_PROJECT_KEY, projectId);
    } else {
      window.localStorage.removeItem(SELECTED_PROJECT_KEY);
    }
    window.dispatchEvent(new CustomEvent(SELECTED_PROJECT_EVENT, { detail: { projectId } }));
  } catch {
    // Storage is best-effort only.
  }
}
