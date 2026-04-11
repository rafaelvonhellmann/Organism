'use client';

import { useEffect, useState } from 'react';

const SELECTED_PROJECT_KEY = 'organism.selectedProject';

const PROJECT_DISPLAY_NAMES: Record<string, string> = {
  'synapse': 'Synapse',
  'tokens-for-good': 'Tokens for Good',
  'organism': 'Organism (internal)',
};

function displayName(id: string): string {
  return PROJECT_DISPLAY_NAMES[id] ?? id;
}

function readSavedProject(): string {
  try {
    return window.localStorage.getItem(SELECTED_PROJECT_KEY) ?? '';
  } catch {
    return '';
  }
}

function persistProject(projectId: string): void {
  try {
    if (projectId) {
      window.localStorage.setItem(SELECTED_PROJECT_KEY, projectId);
    } else {
      window.localStorage.removeItem(SELECTED_PROJECT_KEY);
    }
  } catch {
    // Storage is best-effort only.
  }
}

/** Pick the best default: keep prior selection when possible, otherwise prefer All Projects. */
function pickDefault(projects: string[], allowAllProjects: boolean, currentProject: string): string {
  if (currentProject && projects.includes(currentProject)) return currentProject;
  const savedProject = readSavedProject();
  if (savedProject && projects.includes(savedProject)) return savedProject;
  if (allowAllProjects) return '';
  const nonInternal = projects.find(p => p !== 'organism');
  return nonInternal ?? '';
}

interface HeaderProps {
  title: string;
  project: string;
  onProjectChange: (p: string) => void;
  lastUpdated: Date | null;
  allowAllProjects?: boolean;
  autoSelectProject?: boolean;
}

export function Header({
  title,
  project,
  onProjectChange,
  lastUpdated,
  allowAllProjects = true,
  autoSelectProject = true,
}: HeaderProps) {
  const [projects, setProjects] = useState<string[]>([]);
  const [ago, setAgo] = useState('');
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then((list: string[]) => {
        setProjects(list);
        if (!initialized && autoSelectProject) {
          const nextProject = pickDefault(list, allowAllProjects, project);
          onProjectChange(nextProject);
          setInitialized(true);
        }
        if (!initialized && !autoSelectProject) {
          setInitialized(true);
        }
      })
      .catch(() => {});
  }, [allowAllProjects, autoSelectProject, initialized, onProjectChange, project]);

  useEffect(() => {
    if (!initialized) return;
    persistProject(project);
  }, [initialized, project]);

  // Update "ago" every second
  useEffect(() => {
    if (!lastUpdated) return;
    const tick = () => {
      const s = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
      setAgo(s < 5 ? 'just now' : `${s}s ago`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  return (
    <header className="h-14 border-b border-edge bg-gradient-to-r from-surface/90 via-surface/80 to-surface/90 backdrop-blur-md flex items-center justify-between px-4 md:px-6 sticky top-0 z-20">
      <h2 className="text-base font-semibold text-zinc-100">{title}</h2>

      <div className="flex items-center gap-4">
        {/* Last updated */}
        {lastUpdated && (
          <span className="text-xs text-zinc-500 flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse-dot" />
            {ago}
          </span>
        )}

        {/* Project selector */}
        <select
          value={project}
          onChange={e => {
            const nextProject = e.target.value;
            persistProject(nextProject);
            onProjectChange(nextProject);
          }}
          className="bg-zinc-800 border border-edge rounded-md px-2.5 py-1.5 text-sm text-zinc-300 focus:outline-none focus:border-emerald-500 cursor-pointer"
        >
          {allowAllProjects && <option value="">All Projects</option>}
          {projects.map(p => (
            <option key={p} value={p}>{displayName(p)}</option>
          ))}
        </select>
      </div>
    </header>
  );
}
