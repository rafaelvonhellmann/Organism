# Nielsen's 10 Usability Heuristics

Source: nngroup.com — Jakob Nielsen, 1994. Unchanged and validated across 249 usability problems.

## 1. Visibility of System Status
The system must always keep users informed about what is going on, through appropriate feedback within a reasonable amount of time.

**Application:**
- Show current state clearly (loading, processing, complete, error)
- Provide feedback immediately after every user action
- Display progress for multi-step processes
- Show "you are here" indicators in navigation
- Communicate consequences before destructive actions

**Dashboard rule:** Every agent task must show its current state. Every user decision must produce visible confirmation.

## 2. Match Between System and Real World
Speak the user's language. Use words, phrases, and concepts familiar to the user, not internal jargon.

**Application:**
- Use domain language the user knows (not developer terms)
- Follow real-world conventions and natural mappings
- Present information in a natural, logical order
- Icons should match user expectations, not developer metaphors

**Dashboard rule:** Show "Technology Strategy" not "cto task 3aabc262". Show "Python missing in Docker" not "architecture review for tokens-for-good".

## 3. User Control and Freedom
Users make mistakes. Provide clearly marked "emergency exits" without requiring extended processes.

**Application:**
- Support Undo and Redo everywhere
- Provide Cancel buttons and escape routes
- Allow users to go back without losing work
- Never trap users in a flow they can't exit

**Dashboard rule:** Every decision (approve/reject) must be reversible. "Skip" must always be available. Back navigation must work.

## 4. Consistency and Standards
Users should not wonder whether different words, situations, or actions mean the same thing. Follow platform conventions.

**Application:**
- Internal consistency: same patterns within the product
- External consistency: follow platform and industry conventions
- Same visual treatment for same-type elements
- Predictable behavior for interactive elements

**Dashboard rule:** All task cards look and behave the same. All feedback actions use the same pattern. Status colors are universal.

## 5. Error Prevention
Good error messages are important, but preventing errors is better.

**Application:**
- Eliminate error-prone conditions (don't let users make the mistake)
- Provide confirmation before destructive actions
- Use smart defaults that are usually correct
- Validate input before submission, not after

**Dashboard rule:** Don't allow "reject" without a reason. Confirm batch operations. Pre-select the most common action.

## 6. Recognition Rather Than Recall
Minimize memory load. Make elements, actions, and options visible. Users should not have to remember information across screens.

**Application:**
- Show all relevant options instead of requiring users to remember them
- Provide contextual help at the point of need
- Keep task context visible during decision-making
- Use labels, not just icons

**Dashboard rule:** Show the full assessment while the user decides. Show "3 of 7 reviewed" not just "next". Show which perspective this task belongs to.

## 7. Flexibility and Efficiency of Use
Shortcuts for experts that don't burden novices. Cater to both.

**Application:**
- Keyboard shortcuts for power users
- Batch operations for efficiency
- Customizable workflows
- Progressive complexity — simple by default, powerful when needed

**Dashboard rule:** Allow keyboard navigation (J/K for next/prev, A for approve, R for request changes). Allow "approve all" for low-risk items.

## 8. Aesthetic and Minimalist Design
Every extra element competes with relevant elements and diminishes their visibility. Focus on essentials.

**Application:**
- Remove anything that doesn't serve the user's current goal
- Prioritize content over decoration
- Use whitespace as a design element
- Information density should match the task

**Dashboard rule:** Hide pipeline internals (grill-me, codex-review) by default. Show only what Rafael needs to decide on. No raw JSON. No task IDs unless requested.

## 9. Help Users Recognize, Diagnose, and Recover from Errors
Error messages in plain language. Precisely indicate the problem. Constructively suggest a solution.

**Application:**
- Use human language, not error codes
- Explain what happened and why
- Offer a clear path to recovery
- Use visual prominence (color, position) for errors

**Dashboard rule:** When an agent fails, show "CTO analysis timed out — rerun?" not "Error: claude CLI timed out after 15 minutes code E001".

## 10. Help and Documentation
Best if not needed. When necessary, make it easy to search, focused on the user's task, concrete steps.

**Application:**
- Provide contextual help at the moment of need
- Make documentation searchable
- List concrete steps, not abstract concepts
- Keep it short

**Dashboard rule:** First-time users should understand the triage queue without a tutorial. Tooltips on hover for non-obvious elements.
