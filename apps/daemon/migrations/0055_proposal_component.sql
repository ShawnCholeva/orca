-- SP2: proposals gain a second revision target (step_output_schema). Additive.
ALTER TABLE template_instruction_proposals ADD COLUMN component TEXT NOT NULL DEFAULT 'step_instructions';
