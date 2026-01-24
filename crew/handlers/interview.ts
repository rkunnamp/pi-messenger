/**
 * Crew - Interview Handler
 * 
 * Generates interview questions for requirement clarification.
 * Works with current plan's PRD.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { MessengerState, Dirs } from "../../lib.js";
import type { CrewParams } from "../types.js";
import { result } from "../utils/result.js";
import { spawnAgents } from "../agents.js";
import { discoverCrewAgents } from "../utils/discover.js";
import * as store from "../store.js";
import { getCrewDir } from "../store.js";

export async function execute(
  params: CrewParams,
  _state: MessengerState,
  _dirs: Dirs,
  ctx: ExtensionContext
) {
  const cwd = ctx.cwd ?? process.cwd();
  const { target } = params;

  // Check for interview-generator agent
  const availableAgents = discoverCrewAgents(cwd);
  const hasGenerator = availableAgents.some(a => a.name === "crew-interview-generator");
  if (!hasGenerator) {
    return result("Error: crew-interview-generator agent not found.", {
      mode: "interview",
      error: "no_generator"
    });
  }

  // Determine feature description from plan or target
  let featureDescription: string;
  const plan = store.getPlan(cwd);

  if (target) {
    // Use target as feature description
    featureDescription = target;
  } else if (plan) {
    // Use plan's PRD
    const prdPath = path.isAbsolute(plan.prd) ? plan.prd : path.join(cwd, plan.prd);
    if (fs.existsSync(prdPath)) {
      featureDescription = fs.readFileSync(prdPath, "utf-8");
    } else {
      const planSpec = store.getPlanSpec(cwd);
      featureDescription = planSpec ?? `Plan: ${plan.prd}`;
    }
  } else {
    return result("Error: No plan found. Create one first with pi_messenger({ action: \"plan\" }) or provide a target.", {
      mode: "interview",
      error: "no_plan"
    });
  }

  // Spawn interview generator
  const [genResult] = await spawnAgents([{
    agent: "crew-interview-generator",
    task: `Generate interview questions to clarify requirements for this feature:

${featureDescription}

Follow your output format exactly for question parsing.`
  }], 1, cwd);

  if (genResult.exitCode !== 0) {
    return result(`Error: Interview generator failed: ${genResult.error ?? "Unknown error"}`, {
      mode: "interview",
      error: "generator_failed"
    });
  }

  // Parse questions from output
  const questions = parseInterviewQuestions(genResult.output);

  if (questions.length === 0) {
    return result("No interview questions could be parsed from generator output.", {
      mode: "interview",
      error: "no_questions",
      rawOutput: genResult.output.slice(0, 500)
    });
  }

  // Write questions to JSON file for pi's interview tool
  const crewDir = getCrewDir(cwd);
  const questionsPath = path.join(crewDir, "interview-questions.json");
  
  const questionsJson = {
    title: `Interview: ${plan?.prd ?? "Feature Clarification"}`,
    questions: questions.map((q, i) => ({
      id: `q${i + 1}`,
      type: q.type,
      question: q.question,
      options: q.options,
    })),
  };

  fs.mkdirSync(crewDir, { recursive: true });
  fs.writeFileSync(questionsPath, JSON.stringify(questionsJson, null, 2));

  // Build question preview
  const preview = questions.slice(0, 5).map((q, i) => {
    const typeIcon = q.type === "single" ? "○" : q.type === "multi" ? "☐" : "✎";
    const optionsText = q.options ? ` (${q.options.length} options)` : "";
    return `${i + 1}. ${typeIcon} ${q.question.slice(0, 60)}${q.question.length > 60 ? "..." : ""}${optionsText}`;
  }).join("\n");

  const moreText = questions.length > 5 
    ? `\n... and ${questions.length - 5} more questions` 
    : "";

  const text = `# Interview Generated

**Questions:** ${questions.length}
**File:** ${questionsPath}
${plan ? `**PRD:** ${plan.prd}` : ""}

## Preview

${preview}${moreText}

## Next Steps

Run the interview using pi's interview tool:
\`\`\`typescript
interview({ questions: "${questionsPath}" })
\`\`\`

After completing the interview, use the responses to refine task specs or update the plan.`;

  return result(text, {
    mode: "interview",
    prd: plan?.prd,
    questionCount: questions.length,
    questionsPath,
    questionTypes: {
      single: questions.filter(q => q.type === "single").length,
      multi: questions.filter(q => q.type === "multi").length,
      text: questions.filter(q => q.type === "text").length,
    }
  });
}

// =============================================================================
// Question Parsing
// =============================================================================

interface InterviewQuestion {
  type: "single" | "multi" | "text";
  question: string;
  options?: string[];
}

/**
 * Parses interview questions from the generator output.
 * 
 * Expected format:
 * ### Q1 (single)
 * Question text?
 * - Option 1
 * - Option 2
 * 
 * ### Q2 (text)
 * Question text?
 */
function parseInterviewQuestions(output: string): InterviewQuestion[] {
  const questions: InterviewQuestion[] = [];

  // Match question blocks
  const questionRegex = /###\s*Q\d+\s*\((\w+)\)\s*\n([\s\S]*?)(?=###\s*Q\d+|$)/gi;
  let match;

  while ((match = questionRegex.exec(output)) !== null) {
    const typeRaw = match[1].toLowerCase();
    const body = match[2].trim();

    // Normalize type
    let type: "single" | "multi" | "text";
    if (typeRaw === "single" || typeRaw === "radio") {
      type = "single";
    } else if (typeRaw === "multi" || typeRaw === "multiple" || typeRaw === "checkbox") {
      type = "multi";
    } else {
      type = "text";
    }

    // First line is the question
    const lines = body.split("\n").map(l => l.trim()).filter(Boolean);
    const question = lines[0];

    // Remaining lines starting with - are options
    const options = lines
      .slice(1)
      .filter(l => l.startsWith("-") || l.startsWith("*"))
      .map(l => l.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);

    questions.push({
      type,
      question,
      options: options.length > 0 ? options : undefined,
    });
  }

  return questions;
}
