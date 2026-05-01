# Synapse Medical Content Review Playbook

This playbook makes medical-content review LLM-legible while keeping final medical reliability non-delegable.

## Contract

- Review Synapse content as medical education, not clinical advice.
- Cite source material, syllabus references, question records, or supplied evidence for every finding.
- Separate factual correctness, exam alignment, educational quality, and AI-safety risk.
- Flag uncertainty rather than filling gaps from memory.
- Mark public-release or medical-reliance decisions as Rafael/professional approval required.

## Topic Statuses

| Status | Meaning |
| --- | --- |
| GREEN | Supported by cited source and suitable for educational use |
| YELLOW | Mostly suitable but needs clarification, citation, or wording change |
| RED | Incorrect, unsafe, misleading, uncited, or not aligned to exam context |
| GRAY | Not relevant to the reviewed item |

## Review Topics

### MED-SOURCE-CITATION

Every benchmark answer, explanation, grading rubric, and VIVA model answer should cite source material or a known syllabus/learning objective.

### MED-EXAM-ALIGNMENT

Content should map to ANZCA, ACEM, or CICM learning objectives and exam style without implying official endorsement.

### MED-AI-GRADING-SAFETY

AI grading feedback must be framed as study feedback, not an authoritative assessment of clinical competence.

### MED-CLINICAL-BOUNDARY

Generated content must not provide patient-specific clinical advice, diagnosis, or treatment instructions.

### MED-COPYRIGHT-OVERLAP

Flag verbatim exam recalls, college-specific wording, or exam-year references that could overlap with protected expression.

## Required Output

1. Summary verdict.
2. Findings table: Topic, Status, Source Citation, Risk, Required Fix.
3. Public-release blockers.
4. Suggested wording changes.
5. Approval required: none, Rafael, or qualified medical/legal reviewer.
