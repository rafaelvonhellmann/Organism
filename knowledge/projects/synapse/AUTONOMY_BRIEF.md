## Synapse Safe Autonomy Brief

Synapse is a medical-education product. Treat any task that touches grading, scoring, answer keys, rubrics, benchmarks, MCQ/SAQ/VIVA assessment logic, model answers, or medical-content-facing judgments as a protected surface.

What Organism may do autonomously right now:
- review the repo and tasklist
- validate build, lint, typecheck, test, and deployment readiness
- inspect auth, admin UI, observability, monitoring, CI, and documentation
- propose safe backlog items for future bounded implementation

What Organism must not implement autonomously yet:
- grading or scoring logic
- answer-key, benchmark, rubric, or model-answer generation
- medical-content-facing evaluation flows
- production deployment
- destructive migrations or user-facing medical claims

If there is any uncertainty, prefer read-only review or validation and explicitly say which surface is protected.
