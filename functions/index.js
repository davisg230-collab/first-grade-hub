const fs = require("fs");
const path = require("path");
const { logger } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const MATH_STANDARDS_REFERENCE_PATH = path.join(__dirname, "data", "math-standards-reference.json");
const SKILLS_STANDARDS_REFERENCE_PATH = path.join(__dirname, "data", "skills-standards-reference.json");
let mathStandardsReferenceCache;
let skillsStandardsReferenceCache;
const MAIL_COLLECTION = process.env.MAIL_COLLECTION || "mail";
const APPROVED_EDITOR_EMAILS = new Set([
  "davisg230@gmail.com",
  "lvest1010@gmail.com",
]);
const DEFAULT_TEACHER_EMAILS = [
  "dgonzalezjr@crossroadsschoolskc.org",
  "lvest1010@gmail.com",
];
const NOTIFICATION_RECIPIENTS = uniqueRecipients([
  ...DEFAULT_TEACHER_EMAILS,
  ...parseRecipientList(process.env.TEACHER_NOTIFICATION_EMAIL),
  ...parseRecipientList(process.env.TEACHER_NOTIFICATION_EMAILS),
]);

exports.queueTeacherActivityEmail = onDocumentCreated("teacherActivity/{activityId}", async (event) => {
  const snapshot = event.data;
  if (!snapshot) {
    logger.warn("Teacher activity email skipped because the activity snapshot was missing.", {
      activityId: event.params.activityId,
    });
    return;
  }

  const activity = snapshot.data() || {};
  const email = buildActivityEmail(activity, event.params.activityId);

  await admin.firestore().collection(MAIL_COLLECTION).add(email);

  logger.info("Queued teacher activity email.", {
    activityId: event.params.activityId,
    activityType: activity.type || "activity",
    mailCollection: MAIL_COLLECTION,
    recipientCount: NOTIFICATION_RECIPIENTS.length,
  });
});

exports.analyzeCurriculumLesson = onCall(
  {
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (request) => {
    const email = asText(request.auth && request.auth.token && request.auth.token.email).toLowerCase();
    if (!APPROVED_EDITOR_EMAILS.has(email)) {
      throw new HttpsError("permission-denied", "Teacher sign-in is required to analyze curriculum lessons.");
    }

    const data = request.data || {};
    const subject = normalizeCurriculumSubject(data.subject);
    const sourceText = asText(data.sourceText);
    if (sourceText.length < 40) {
      throw new HttpsError("invalid-argument", "Paste one full lesson before running the AI analyzer.");
    }
    if (sourceText.length > 20000) {
      throw new HttpsError("invalid-argument", "Paste one lesson at a time so the AI request stays focused and low-cost.");
    }

    const apiKey = OPENAI_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "The OpenAI API key is not configured yet.");
    }

    const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
    const prompt = buildCurriculumAnalysisPrompt({
      subject,
      unitOrModule: asText(data.unitOrModule),
      lessonNumber: asText(data.lessonNumber),
      lessonTitle: asText(data.lessonTitle),
      sourceText,
    });

    let response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          instructions: [
            "You are a careful first grade curriculum assistant.",
            "Use the provided lesson source as evidence, but create teacher-useful planning fields when the lesson implies them.",
            "Do not make up lesson facts, materials, URLs, or official standard codes that are not supported by the source.",
            "The I can statement, priority standard focus, sounds/spellings, vocabulary, parent summary, family questions, and teacher notes are expected to be inferred or written from the lesson when possible.",
            "Leave videoLinks empty unless explicit URLs are present in the lesson source.",
            "Do not mark a field missing only because the lesson did not label it explicitly.",
            "Only add missingInformation when the source is too incomplete to make a responsible teacher draft, except do not mark missing video links.",
            "Write parent-facing language clearly and warmly for families.",
            "Always refer to the children in the class as scholars in newly written explanatory fields. Preserve official curriculum titles and official standard wording exactly as sourced, even when that source wording uses student, child, or another term.",
            "Keep generated sections concise so the structured response stays complete: at most 5 teacher notes, 3 family questions, 12 vocabulary items, and 12 materials. Keep standard notes to one short line per cited standard, and do not repeat the full official standard wording there.",
          ].join(" "),
          input: prompt,
          max_output_tokens: subject === "math" ? 6000 : 2200,
          text: {
            format: {
              type: "json_schema",
              name: "curriculum_lesson_analysis",
              strict: true,
              schema: CURRICULUM_LESSON_SCHEMA,
            },
          },
        }),
      });
    } catch (error) {
      logger.error("OpenAI curriculum request failed before response.", { message: error.message });
      throw new HttpsError("unavailable", "The AI service could not be reached. Please try again.");
    }

    const responseBody = await readJsonResponse(response);
    if (!response.ok) {
      const openAiError = responseBody && responseBody.error ? responseBody.error : {};
      logger.error("OpenAI curriculum request failed.", {
        status: response.status,
        code: openAiError.code,
        type: openAiError.type,
        param: openAiError.param,
        message: openAiError.message,
        ...buildCurriculumResponseDiagnostics(responseBody, extractOpenAIOutputText(responseBody)),
      });
      throw new HttpsError("failed-precondition", getOpenAICurriculumFailureMessage(response.status, responseBody));
    }

    const outputText = extractOpenAIOutputText(responseBody);
    const responseDiagnostics = buildCurriculumResponseDiagnostics(responseBody, outputText);
    if (responseDiagnostics.truncated) {
      const incompleteReason = asText(responseBody.incomplete_details && responseBody.incomplete_details.reason) || "unknown";
      logger.error("OpenAI curriculum response was incomplete.", {
        ...responseDiagnostics,
        reason: incompleteReason,
      });
      throw new HttpsError(
        "internal",
        incompleteReason === "max_output_tokens"
          ? "The AI draft was cut off before it finished. Please try analyzing this lesson again."
          : "The AI returned an incomplete lesson draft. Please try analyzing this lesson again."
      );
    }

    if (!outputText) {
      logger.error("OpenAI curriculum response had no output text.", responseDiagnostics);
      throw new HttpsError("internal", "The AI analyzer did not return a usable draft.");
    }

    let analysis;
    try {
      analysis = parseCurriculumAnalysisOutput(outputText);
    } catch (error) {
      logger.error("OpenAI curriculum response was not valid JSON.", {
        ...buildCurriculumResponseDiagnostics(responseBody, outputText, error),
      });
      if (!responseDiagnostics.truncated && !responseDiagnostics.safetyInterruption) {
        const repairedText = await requestCurriculumJsonRepair({
          apiKey,
          model,
          outputText,
          maxOutputTokens: subject === "math" ? 6000 : 2200,
        });
        if (repairedText) {
          try {
            analysis = parseCurriculumAnalysisOutput(repairedText);
            logger.info("OpenAI curriculum response was repaired into valid JSON.", {
              responseId: responseBody && responseBody.id,
              originalOutputCharacters: outputText.length,
              repairedOutputCharacters: repairedText.length,
            });
          } catch (repairError) {
            logger.error("OpenAI curriculum JSON repair was not valid JSON.", {
              ...buildCurriculumResponseDiagnostics({}, repairedText, repairError),
            });
          }
        }
      }
      if (!analysis) {
        throw new HttpsError(
          "internal",
          "The AI response was incomplete or not valid JSON. Please try analyzing the lesson again."
        );
      }
    }

    try {
      analysis = normalizeCurriculumAnalysisShape(analysis, subject);
    } catch (error) {
      logger.error("OpenAI curriculum response failed shape validation.", {
        message: error.message,
        fieldErrors: error.fieldErrors || [],
      });
      throw new HttpsError(
        "internal",
        "The AI draft could not be normalized to the lesson format. Please try analyzing the lesson again."
      );
    }

    return {
      analysis: normalizeCurriculumAnalysis(analysis, sourceText),
      analyzedAt: new Date().toISOString(),
      model,
    };
  }
);

exports.analyzeCurriculumUnit = onCall(
  {
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (request) => {
    const email = asText(request.auth && request.auth.token && request.auth.token.email).toLowerCase();
    if (!APPROVED_EDITOR_EMAILS.has(email)) {
      throw new HttpsError("permission-denied", "Teacher sign-in is required to analyze curriculum units.");
    }

    const data = request.data || {};
    const subject = normalizeCurriculumSubject(data.subject);
    const unitTitle = asText(data.unitTitle);
    const sourceText = asText(data.sourceText);
    if (sourceText.length < 40) {
      throw new HttpsError("invalid-argument", "Upload one complete unit or module PDF before running the AI analyzer.");
    }
    if (sourceText.length > 60000) {
      throw new HttpsError("invalid-argument", "That unit PDF is very long. Use one unit or module at a time, or trim the extracted text before analyzing.");
    }

    const apiKey = OPENAI_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "The OpenAI API key is not configured yet.");
    }

    const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
    const prompt = buildCurriculumUnitPrompt({ subject, unitTitle, sourceText });

    let response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          instructions: [
            "You are a careful first grade curriculum assistant creating a teacher-reviewed unit overview.",
            "Use the complete unit source as evidence, but write concise parent-friendly fields that can be shown on a View by Unit page.",
            "Do not invent official standard codes, lesson details, materials, or topics that are not supported by the source.",
            "Infer the main priority standard and create one short scholar-friendly I can statement from the unit's main learning goal.",
            "Use plain language for families and always refer to the children in the class as scholars. Never use student, students, child, children, kid, or kids; use scholar or scholars instead.",
            "Return empty arrays for categories that do not fit the selected subject.",
          ].join(" "),
          input: prompt,
          max_output_tokens: 1800,
          text: {
            format: {
              type: "json_schema",
              name: "curriculum_unit_analysis",
              strict: true,
              schema: CURRICULUM_UNIT_SCHEMA,
            },
          },
        }),
      });
    } catch (error) {
      logger.error("OpenAI curriculum unit request failed before response.", { message: error.message });
      throw new HttpsError("unavailable", "The AI unit analyzer could not be reached. Please try again.");
    }

    const responseBody = await readJsonResponse(response);
    if (!response.ok) {
      const openAiError = responseBody && responseBody.error ? responseBody.error : {};
      logger.error("OpenAI curriculum unit request failed.", {
        status: response.status,
        code: openAiError.code,
        type: openAiError.type,
        param: openAiError.param,
        message: openAiError.message,
      });
      throw new HttpsError("failed-precondition", getOpenAICurriculumFailureMessage(response.status, responseBody));
    }

    const outputText = extractOpenAIOutputText(responseBody);
    if (!outputText) {
      logger.error("OpenAI curriculum unit response had no output text.", { responseId: responseBody && responseBody.id });
      throw new HttpsError("internal", "The AI unit analyzer did not return a usable draft.");
    }

    let analysis;
    try {
      analysis = JSON.parse(outputText);
    } catch (error) {
      logger.error("OpenAI curriculum unit response was not valid JSON.", { message: error.message });
      throw new HttpsError("internal", "The AI unit analyzer returned a draft in the wrong format.");
    }

    return {
      analysis: normalizeCurriculumUnitAnalysis(analysis, sourceText),
      analyzedAt: new Date().toISOString(),
      model,
    };
  }
);

exports.generateCurriculumSpotlight = onCall(
  {
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 90,
    memory: "512MiB",
  },
  async (request) => {
    const email = asText(request.auth && request.auth.token && request.auth.token.email).toLowerCase();
    if (!APPROVED_EDITOR_EMAILS.has(email)) {
      throw new HttpsError("permission-denied", "Teacher sign-in is required to write curriculum spotlights.");
    }

    const data = request.data || {};
    const subject = normalizeCurriculumSubject(data.subject);
    const lessons = normalizeSpotlightLessons(data.lessons).slice(0, 5);
    if (!lessons.length) {
      throw new HttpsError("invalid-argument", "Choose current or previous week lessons before writing a spotlight.");
    }

    const apiKey = OPENAI_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "The OpenAI API key is not configured yet.");
    }

    const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
    const prompt = buildCurriculumSpotlightPrompt({
      subject,
      weekLabel: asText(data.weekLabel),
      moduleLabel: asText(data.moduleLabel),
      lessons,
    });

    let response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          instructions: [
            "You write concise first grade family updates.",
            "Use the selected current or previous week lesson objectives as the source.",
            "Combine the lessons into one simple, warm summary instead of listing each objective separately.",
            "Write for families who may not know curriculum language.",
            "Do not mention upcoming lessons, the teacher, standards codes, lesson numbers, module numbers, or AI.",
            "Do not add a separate vocabulary sentence. Vocabulary is shown elsewhere on the page.",
            "Always refer to the children in the class as scholars. Never use student, students, child, children, kid, or kids; use scholar or scholars instead.",
            "Also create 2 or 3 short Ask your scholar questions based on the combined main learning targets from the selected current or previous week lessons.",
            "Do not create one question for each individual story. Make the questions connect the week's overall learning, and never use upcoming lessons as the source.",
          ].join(" "),
          input: prompt,
          max_output_tokens: 450,
          text: {
            format: {
              type: "json_schema",
              name: "curriculum_week_spotlight",
              strict: true,
              schema: CURRICULUM_SPOTLIGHT_SCHEMA,
            },
          },
        }),
      });
    } catch (error) {
      logger.error("OpenAI spotlight request failed before response.", { message: error.message });
      throw new HttpsError("unavailable", "The AI spotlight writer could not be reached. Please try again.");
    }

    const responseBody = await readJsonResponse(response);
    if (!response.ok) {
      const openAiError = responseBody && responseBody.error ? responseBody.error : {};
      logger.error("OpenAI spotlight request failed.", {
        status: response.status,
        code: openAiError.code,
        type: openAiError.type,
        param: openAiError.param,
        message: openAiError.message,
      });
      throw new HttpsError("failed-precondition", getOpenAICurriculumFailureMessage(response.status, responseBody));
    }

    const outputText = extractOpenAIOutputText(responseBody);
    if (!outputText) {
      logger.error("OpenAI spotlight response had no output text.", { responseId: responseBody && responseBody.id });
      throw new HttpsError("internal", "The AI spotlight writer did not return usable text.");
    }

    let result;
    try {
      result = JSON.parse(outputText);
    } catch (error) {
      logger.error("OpenAI spotlight response was not valid JSON.", { message: error.message });
      throw new HttpsError("internal", "The AI spotlight writer returned text in the wrong format.");
    }

    return {
      spotlight: normalizeSpotlightText(result.spotlight),
      familyQuestions: normalizeStringArray(result.familyQuestions)
        .map(normalizeScholarLanguage)
        .filter(Boolean)
        .slice(0, 3),
      sourceConfidence: ["high", "medium", "low"].includes(result.sourceConfidence) ? result.sourceConfidence : "medium",
      generatedAt: new Date().toISOString(),
      model,
    };
  }
);

const CURRICULUM_LESSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: { type: "string", enum: ["skills", "listening", "math", "other"] },
    unitOrModule: { type: "string" },
    lessonNumber: { type: "string" },
    lessonTitle: { type: "string" },
    officialLessonTitle: { type: "string" },
    iCanStatement: { type: "string" },
    priorityStandardCode: { type: "string" },
    priorityStandardNumber: { type: "string" },
    priorityStandardWording: { type: "string" },
    priorityStandard: { type: "string" },
    supportingStandards: { type: "array", items: { type: "string" } },
    mathematicalPractices: { type: "array", items: { type: "string" } },
    standardNotes: { type: "string" },
    objective: { type: "string" },
    vocabulary: { type: "array", items: { type: "string" } },
    soundSpellings: { type: "array", items: { type: "string" } },
    materials: { type: "array", items: { type: "string" } },
    videoLinks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          note: { type: "string" },
        },
        required: ["title", "url", "note"],
      },
    },
    parentSummary: { type: "string" },
    familyQuestions: { type: "array", items: { type: "string" } },
    teacherNotes: { type: "array", items: { type: "string" } },
    missingInformation: { type: "array", items: { type: "string" } },
    sourceConfidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: [
    "subject",
    "unitOrModule",
    "lessonNumber",
    "lessonTitle",
    "officialLessonTitle",
    "iCanStatement",
    "priorityStandardCode",
    "priorityStandardNumber",
    "priorityStandardWording",
    "priorityStandard",
    "supportingStandards",
    "mathematicalPractices",
    "standardNotes",
    "objective",
    "vocabulary",
    "soundSpellings",
    "materials",
    "videoLinks",
    "parentSummary",
    "familyQuestions",
    "teacherNotes",
    "missingInformation",
    "sourceConfidence",
  ],
};

const CURRICULUM_UNIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    unitTitle: { type: "string" },
    priorityStandard: { type: "string" },
    iCanStatement: { type: "string" },
    description: { type: "string" },
    soundSpellings: { type: "array", items: { type: "string" } },
    sightWords: { type: "array", items: { type: "string" } },
    vocabulary: { type: "array", items: { type: "string" } },
    strategies: { type: "array", items: { type: "string" } },
    sourceConfidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: [
    "unitTitle",
    "priorityStandard",
    "iCanStatement",
    "description",
    "soundSpellings",
    "sightWords",
    "vocabulary",
    "strategies",
    "sourceConfidence",
  ],
};

const CURRICULUM_SPOTLIGHT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    spotlight: { type: "string" },
    familyQuestions: { type: "array", items: { type: "string" } },
    sourceConfidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["spotlight", "familyQuestions", "sourceConfidence"],
};

function buildActivityEmail(activity, activityId) {
  const title = asText(activity.title) || labelForType(activity.type);
  const details = asText(activity.details) || "A parent activity was recorded on the First Grade Hub.";
  const page = asText(activity.page) || "First Grade Hub";
  const createdAt = readableDate(activity.createdAt) || asText(activity.createdAtLocal) || "Time not provided";
  const activityType = asText(activity.type) || "activity";

  const subject = `First Grade Hub: ${title}`;
  const text = [
    details,
    "",
    `Page: ${page}`,
    `Type: ${activityType}`,
    `Time: ${createdAt}`,
    `Activity ID: ${activityId}`,
  ].join("\n");

  const html = `
    <p>${escapeHtml(details)}</p>
    <table cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
      <tr><td><strong>Page</strong></td><td>${escapeHtml(page)}</td></tr>
      <tr><td><strong>Type</strong></td><td>${escapeHtml(activityType)}</td></tr>
      <tr><td><strong>Time</strong></td><td>${escapeHtml(createdAt)}</td></tr>
      <tr><td><strong>Activity ID</strong></td><td>${escapeHtml(activityId)}</td></tr>
    </table>
  `;

  return {
    to: NOTIFICATION_RECIPIENTS,
    message: {
      subject,
      text,
      html,
    },
  };
}

function parseRecipientList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((recipient) => recipient.trim().toLowerCase())
    .filter(Boolean);
}

function uniqueRecipients(recipients) {
  return Array.from(new Set(recipients.filter(Boolean)));
}

function labelForType(type) {
  switch (type) {
    case "snack":
      return "Snack signup updated";
    case "shoutout":
      return "New student shoutout";
    case "volunteer":
      return "Volunteer signup updated";
    case "transportation":
      return "Transportation note updated";
    default:
      return "New parent activity";
  }
}

function loadMathStandardsReference() {
  if (mathStandardsReferenceCache) return mathStandardsReferenceCache;
  try {
    const reference = JSON.parse(fs.readFileSync(MATH_STANDARDS_REFERENCE_PATH, "utf8"));
    if (!reference || !Array.isArray(reference.standards)) {
      throw new Error("The math standards reference has no standards array.");
    }
    mathStandardsReferenceCache = reference;
    return reference;
  } catch (error) {
    logger.error("Math standards reference could not be loaded.", { message: error.message });
    throw new Error("The permanent math standards reference is unavailable.");
  }
}

function extractMathStandardCodes(sourceText) {
  const matches = asText(sourceText).match(/\b(?:K|\d+)\.[A-Z]+\.[A-Z]\.\d+\b|\bMP\d+\b/gi) || [];
  return Array.from(new Set(matches.map((code) => code.toUpperCase())));
}

function isMathematicalPracticeCode(code) {
  return /^MP\d+$/i.test(asText(code));
}

function getMathReferenceMatches(sourceText) {
  const reference = loadMathStandardsReference();
  const standardsByCode = new Map(reference.standards.map((standard) => [standard.code.toUpperCase(), standard]));
  const codes = extractMathStandardCodes(sourceText);
  return {
    codes,
    matches: codes.map((code) => standardsByCode.get(code) || null),
    standardsByCode,
  };
}

function buildMathStandardsContext(sourceText) {
  const { codes, matches } = getMathReferenceMatches(sourceText);
  if (!codes.length) {
    return [
      "Local math standards reference lookup: no standard code was found in the lesson source.",
      "Do not invent a math standard code or official wording.",
    ].join("\n");
  }

  const lines = [
    `Local math standards reference lookup for cited codes: ${codes.join(", ")}`,
    "Use this compact lookup instead of reconstructing official standard wording.",
  ];
  matches.forEach((standard, index) => {
    const code = codes[index];
    if (!standard) {
      lines.push(`- ${code}: Official wording unavailable in the standards reference.`);
      return;
    }
    const footnotes = standard.footnotes && standard.footnotes.length ? ` Footnotes: ${standard.footnotes.join(" ")}` : "";
    lines.push(`- ${code} | ${standard.domain} | ${standard.officialWording}${footnotes}`);
  });
  return lines.join("\n");
}

function loadSkillsStandardsReference() {
  if (skillsStandardsReferenceCache) return skillsStandardsReferenceCache;
  try {
    const reference = JSON.parse(fs.readFileSync(SKILLS_STANDARDS_REFERENCE_PATH, "utf8"));
    if (!reference || !Array.isArray(reference.standards)) {
      throw new Error("The skills standards reference has no standards array.");
    }
    skillsStandardsReferenceCache = reference;
    return reference;
  } catch (error) {
    logger.error("Skills standards reference could not be loaded.", { message: error.message });
    throw new Error("The permanent skills standards reference is unavailable.");
  }
}

function extractSkillsStandardCodes(sourceText) {
  const matches = asText(sourceText).match(/\b(?:RL|RF|SL|L)\.\d+\.\d+[a-z]?\b/gi) || [];
  return Array.from(new Set(matches.map((code) => code.trim())));
}

function getSkillsReferenceMatches(sourceText) {
  const reference = loadSkillsStandardsReference();
  const standardsByCode = new Map(reference.standards.map((standard) => [standard.code.toUpperCase(), standard]));
  const codes = Array.from(new Set(extractSkillsStandardCodes(sourceText).map((code) => {
    const standard = standardsByCode.get(code.toUpperCase());
    return standard ? standard.code : code;
  })));
  return {
    codes,
    matches: codes.map((code) => standardsByCode.get(code.toUpperCase()) || null),
    standardsByCode,
  };
}

function buildSkillsStandardsContext(sourceText) {
  const { codes, matches } = getSkillsReferenceMatches(sourceText);
  if (!codes.length) {
    return [
      "Local Skills standards reference lookup: no Skills standard code was found in the lesson source.",
      "Do not invent a Skills standard code or official wording.",
    ].join("\n");
  }

  const lines = [
    `Local Skills standards reference lookup for cited codes: ${codes.join(", ")}`,
    "Use this compact lookup instead of reconstructing official standard wording.",
  ];
  matches.forEach((standard, index) => {
    const code = codes[index];
    if (!standard) {
      lines.push(`- ${code}: Official wording unavailable in the standards reference.`);
      return;
    }
    lines.push(`- ${code} | ${standard.domain} | ${standard.officialWording}`);
  });
  return lines.join("\n");
}

function buildCurriculumAnalysisPrompt(data) {
  const isMath = String(data.subject || "").trim().toLowerCase() === "math";
  const isSkills = String(data.subject || "").trim().toLowerCase() === "skills";
  const titleAndStandardGuidance = isMath
    ? [
      "This is a MATH lesson. officialLessonTitle is an extraction field, not a generation field. If the source contains an official lesson title, copy it exactly into both lessonTitle and officialLessonTitle, including its wording, numbering, punctuation, and capitalization. Do not shorten, summarize, paraphrase, or replace it with a title based on the objective. If no official title is available, leave both title fields empty rather than inventing a title.",
      "For priorityStandardCode and priorityStandardNumber, return the same official content-standard code exactly as written in the source, such as 1.MD.C.4 or K.CC.C.6. Never invent, infer, or silently omit a code that is present.",
      "For a compact response, put only the selected code in priorityStandardCode and priorityStandardNumber. The server will fill priorityStandardWording and priorityStandard from the permanent reference, so do not copy long official wording into those response fields.",
      "When the local math standards reference lookup provides a match, the server is authoritative for priorityStandardWording, supportingStandards, and mathematicalPractices. Return only codes in supportingStandards and mathematicalPractices. If a cited code has no match, preserve the code; the server will display exactly \"Official wording unavailable in the standards reference.\"",
      "Choose the one content standard most directly assessed by this lesson as the priority standard. If the lesson is foundational and only references an earlier-grade content standard, preserve that earlier-grade code and wording and explain that it is foundational or prerequisite in standardNotes.",
      "Standards beginning with MP are Standards for Mathematical Practice, not content standards. Never put an MP code in priorityStandardCode, priorityStandardNumber, priorityStandard, or supportingStandards. Put each cited MP code and its exact wording in mathematicalPractices instead.",
      "If multiple content standards are listed, put only the main directly assessed content standard in priorityStandardCode and priorityStandardNumber. Put each other content standard code separately in supportingStandards; do not combine multiple standards into a new standard. If the source explicitly identifies foundational standards such as K.CC.C.6 and K.CC.C.7, preserve those codes even when the local reference has no official wording for them.",
      "Leave priorityStandard and priorityStandardWording empty for math unless a compact value is needed; the server will construct the exact teacher-facing display from the selected code and permanent reference. If the source has no content-standard code, leave priorityStandardCode and priorityStandardNumber empty and never create a code.",
      "For standardNotes, write one short line per cited code explaining how this lesson addresses that standard. Do not paraphrase or rewrite the official wording in these notes.",
      "For non-math-only fields officialLessonTitle, priorityStandardCode, priorityStandardNumber, priorityStandardWording, supportingStandards, mathematicalPractices, and standardNotes, return empty values when they do not apply.",
    ]
    : isSkills
      ? [
        "This is a SKILLS lesson. When the source cites a standard code such as RF.1.2b, return the exact code in priorityStandardCode and priorityStandardNumber. Choose the content standard most directly assessed by the lesson as the priority standard and put other cited content-standard codes separately in supportingStandards.",
        "The permanent Skills standards reference is authoritative for official wording. Return compact standard codes in the code fields; the server will fill priorityStandardWording, priorityStandard, and supportingStandards with the exact reference wording. Do not invent a code or rewrite official wording.",
        "If a cited Skills code is not in the permanent reference, preserve the code and let the server display Official wording unavailable in the standards reference.",
        "For standardNotes, write one short line per cited code explaining how this lesson addresses that standard. Do not repeat or rewrite the official wording in these notes.",
        "For non-math-only fields officialLessonTitle, priorityStandardCode, priorityStandardNumber, priorityStandardWording, supportingStandards, mathematicalPractices, and standardNotes, return empty values when they do not apply.",
      ]
    : [
      "For non-math lessons, look first at the objective or main learning goal and create a short 3-7 word lesson name that says what scholars are learning. Use the printed lesson title only if it is already clear and specific. Never use file names, guide names, internal labels, or generic titles like \"Lesson 1\".",
      "For non-math lessons, set officialLessonTitle, priorityStandardCode, priorityStandardNumber, priorityStandardWording, supportingStandards, mathematicalPractices, and standardNotes to empty values unless the source clearly supplies those separate fields.",
      "For priorityStandard, identify the one main standard focus for the lesson, or two if the lesson genuinely has two equal main goals. Prefer standards listed in the source, choosing the one or two that best match the lesson's main teaching point. If the source provides no standard codes, write the main standard skill in plain language instead of inventing a code.",
    ];

  const standardsContext = isMath
    ? buildMathStandardsContext(data.sourceText)
    : isSkills
      ? buildSkillsStandardsContext(data.sourceText)
      : "";
  return [
    "Analyze this first grade curriculum lesson for a teacher-facing lesson library.",
    "",
    `Subject selected by teacher: ${data.subject || "not provided"}`,
    `Unit/module selected by teacher: ${data.unitOrModule || "not provided"}`,
    `Lesson number selected by teacher: ${data.lessonNumber || "not provided"}`,
    `Lesson title selected by teacher: ${data.lessonTitle || "not provided"}`,
    "",
    "Return the exact structured fields requested by the schema.",
    "Use full unit labels in unitOrModule: write Module 1 instead of M1, Mod 1, or module-1, and write Unit 1 instead of U1 when the source uses unit shorthand.",
    ...titleAndStandardGuidance,
    ...(standardsContext ? ["", standardsContext] : []),
    "For the I can statement, create one scholar-friendly sentence starting with \"I can\" by turning the lesson objective or main teaching goal into kid-friendly language. It does not need to appear word-for-word in the source.",
    "For vocabulary, choose lesson words, teaching terms, or curriculum words that scholars or families may need explained, even if the lesson does not provide a labeled vocabulary list.",
    "For soundSpellings, list the letter sounds, spellings, letter pairs, and letter teams explicitly taught or practiced in the lesson. Include entries such as /m/, /sh/, ch, ai, or other grapheme-sound correspondences when the lesson supports them. Keep this separate from vocabulary and return an empty array when the lesson has no sound or spelling focus.",
    "For parentSummary, explain the lesson in 1-2 short family-friendly sentences without curriculum jargon.",
    "For familyQuestions, create 2-3 simple questions families could ask at home based on the lesson, even if the source does not include family questions.",
    "For teacherNotes, include practical teaching notes or watch-fors that are directly grounded in the lesson.",
    "For videoLinks, return an empty array unless the source includes explicit URLs. The teacher can add lesson video links manually later.",
    "For missingInformation, do not list missing I can statements, missing priority labels, missing vocabulary lists, or missing family questions just because those labels are not printed in the source. Only list information that is truly needed but unavailable, such as a missing lesson objective, unreadable lesson text, or a missing standards list when no standard focus can be responsibly identified.",
    "",
    "Lesson source:",
    data.sourceText,
  ].join("\n");
}

function buildCurriculumUnitPrompt(data) {
  const subjectLabel = labelForCurriculumSubject(data.subject);
  const subjectGuidance = {
    skills: "For Skills, pull out the taught sounds and spellings, the exact words from an explicitly labeled Tricky Words or Sight Words list, and family-friendly vocabulary. Leave strategies empty unless the source clearly uses them.",
    listening: "For Listening & Learning, pull out family-friendly vocabulary from the stories and ideas. Leave sounds, sight words, and math strategies empty.",
    math: "For Math, pull out family-friendly vocabulary and the main strategies or models scholars use. Leave sounds and sight words empty.",
    other: "Use the source to choose the most useful family-facing vocabulary and learning strategies, leaving unrelated categories empty.",
  }[data.subject] || "Use the source to choose the most useful family-facing fields.";

  return [
    `Analyze this complete first grade ${subjectLabel} unit or module for the View by Unit page.`,
    `Unit title currently shown on the site: ${data.unitTitle || "not provided"}`,
    "",
    "Return the exact structured fields requested by the schema.",
    "For unitTitle, keep the existing title when it is useful; otherwise create a short clear title based on the unit's main learning focus.",
    "For priorityStandard, identify the one main standard focus for the whole unit, or two only when there are genuinely equal main goals. If the source provides no code, use plain-language standard wording instead of inventing a code.",
    "For iCanStatement, write one short sentence beginning with \"I can\" that summarizes the main unit goal in language a scholar can understand.",
    "For description, combine the unit's major learning goals into 2-3 simple sentences for families. Do not list every lesson or story separately.",
    "For sightWords, use only words that the source explicitly labels under Tricky Words, Sight Words, or High-Frequency Words. Do not infer sight words from general prose, story excerpts, decodable word lists, example words, vocabulary, place names, countries, or names of people. If there is no explicitly labeled list, return an empty array.",
    "This curriculum may distinguish Tricky Words from sight words. The website column is named Sight Words, but when the source provides Tricky Words, place those exact labeled Tricky Words in that column. Never put ordinary example words such as raft, taxi, or veterinarian there just because they appear in the PDF.",
    "If the source contains SIGHT_WORDS_BEGIN and SIGHT_WORDS_END markers, copy only the comma-separated words between those markers into sightWords. Do not copy any content from VOCABULARY_BEGIN/VOCABULARY_END into sightWords.",
    "For vocabulary, choose useful teaching or family-facing terms such as segment, blend, decode, punctuation, or sentence, and give each one a short plain-language definition in the same string (for example, \"Segment: break a word into its individual sounds.\"). Do not copy a source's story-word or decodable-word list into this field just because it is labeled Vocabulary.",
    subjectGuidance,
    "Keep each list focused and remove duplicates. Use empty arrays when the source does not support a category.",
    "",
    "Unit source:",
    data.sourceText,
  ].join("\n");
}

function buildCurriculumSpotlightPrompt(data) {
  const subjectLabel = labelForCurriculumSubject(data.subject);
  const lessonLines = data.lessons.map((lesson, index) => {
    return [
      `Lesson ${index + 1}:`,
      `Day: ${lesson.day || "not provided"}`,
      `Title: ${lesson.lessonTitle || "not provided"}`,
      `Objective: ${lesson.objective || "not provided"}`,
      `I can: ${lesson.iCanStatement || "not provided"}`,
      `Parent summary: ${lesson.parentSummary || "not provided"}`,
      `Vocabulary/teaching words: ${lesson.vocabulary.join(", ") || "not provided"}`,
    ].join("\n");
  }).join("\n\n");

  return [
    `Write the parent-facing weekly spotlight for ${subjectLabel}.`,
    `Week label: ${data.weekLabel || "current or previous week"}`,
    `Module/lesson label shown separately on the page: ${data.moduleLabel || "not provided"}`,
    "",
    "Important:",
    "- This spotlight is for what scholars learned in the current or previous week.",
    "- Do not write about upcoming lessons.",
    "- Read all objectives and combine the big ideas.",
    "- Use 1-2 short sentences, about 35-70 words total.",
    "- Prefer plain language like \"worked with letter sounds\" over curriculum-heavy language like \"phonemes\" unless the word is necessary.",
    "- For Skills, it is okay to mention the main sounds/letters if provided, but do not list so many details that the sentence feels crowded.",
    "- Do not include a separate vocabulary sentence.",
    "- Also write 2 or 3 short family questions based on the combined main learning targets from these current or previous week lessons.",
    "- The family questions should connect the week's overall learning instead of asking one question about each individual story or lesson.",
    "- Do not use upcoming lessons when writing the spotlight or family questions.",
    "",
    "Selected current/previous week lessons:",
    lessonLines,
  ].join("\n");
}

function normalizeSpotlightLessons(value) {
  if (!Array.isArray(value)) return [];
  return value.map((lesson) => ({
    day: asText(lesson && lesson.day),
    lessonNumber: asText(lesson && lesson.lessonNumber),
    lessonTitle: asText(lesson && lesson.lessonTitle),
    objective: asText(lesson && lesson.objective),
    iCanStatement: asText(lesson && lesson.iCanStatement),
    parentSummary: asText(lesson && lesson.parentSummary),
    priorityStandard: asText(lesson && lesson.priorityStandard),
    vocabulary: normalizeStringArray(lesson && lesson.vocabulary).slice(0, 12),
  })).filter((lesson) => lesson.objective || lesson.iCanStatement || lesson.parentSummary || lesson.lessonTitle);
}

function normalizeSpotlightText(value) {
  let text = normalizeScholarLanguage(value).replace(/\s+/g, " ");
  if (!text) return "";
  text = text.replace(/\b(upcoming|next week)\b/gi, "this week");
  text = text.replace(/\s+We will also use words like .+$/i, "");
  if (!/[.!?]$/.test(text)) text += ".";
  return text;
}

function normalizeCurriculumSubject(subject) {
  return ["skills", "listening", "math", "other"].includes(subject) ? subject : "other";
}

function labelForCurriculumSubject(subject) {
  switch (subject) {
    case "skills":
      return "Skills";
    case "listening":
      return "Listening & Learning";
    case "math":
      return "Math";
    default:
      return "First Grade";
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    return { raw: text };
  }
}

function stripCurriculumJsonFences(value) {
  return asText(value)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function buildCurriculumResponseDiagnostics(responseBody, outputText, parseError) {
  const body = responseBody || {};
  const output = asText(outputText);
  const outputItems = Array.isArray(body.output) ? body.output : [];
  const finishReasons = [];
  if (body.finish_reason) finishReasons.push(asText(body.finish_reason));
  outputItems.forEach((item) => {
    if (item && item.finish_reason) finishReasons.push(asText(item.finish_reason));
    if (item && item.status) finishReasons.push(`status:${asText(item.status)}`);
  });
  const incompleteReason = asText(body.incomplete_details && body.incomplete_details.reason);
  const contentTypes = outputItems.flatMap((item) => Array.isArray(item && item.content)
    ? item.content.map((content) => asText(content && content.type)).filter(Boolean)
    : []);
  const errorCode = asText(body.error && body.error.code).toLowerCase();
  const errorMessage = asText(body.error && body.error.message).toLowerCase();
  const safetyInterruption = Boolean(
    body.refusal
    || contentTypes.includes("refusal")
    || /safety|content[_ -]?filter|policy|refusal/.test(incompleteReason.toLowerCase())
    || /safety|content[_ -]?filter|policy|refusal/.test(errorCode)
    || /safety|content[_ -]?filter|policy|refusal/.test(errorMessage)
  );
  const parseCandidate = stripCurriculumJsonFences(output);
  const startsLikeJson = /^[\[{]/.test(parseCandidate);
  const endsLikeJson = /[\]}]$/.test(parseCandidate);
  const parseLooksTruncated = startsLikeJson && !endsLikeJson;
  const statusTruncated = body.status === "incomplete"
    || Boolean(body.incomplete_details)
    || outputItems.some((item) => item && item.status === "incomplete");

  return {
    responseId: asText(body.id),
    responseStatus: asText(body.status),
    truncated: statusTruncated || parseLooksTruncated,
    incompleteReason: incompleteReason || "",
    finishReasons: Array.from(new Set(finishReasons)),
    outputCharacters: output.length,
    outputTokens: body.usage && body.usage.output_tokens,
    outputTokenDetails: body.usage && body.usage.output_tokens_details,
    containsMarkdownFences: /```(?:json)?/i.test(output),
    safetyInterruption,
    outputStart: output.replace(/\s+/g, " ").slice(0, 220),
    outputEnd: output.replace(/\s+/g, " ").slice(-220),
    jsonParseError: parseError ? asText(parseError.message) : "",
  };
}

async function requestCurriculumJsonRepair({ apiKey, model, outputText, maxOutputTokens }) {
  const repairPrompt = [
    "Convert the completed response below into one valid JSON object that exactly matches the supplied curriculum lesson schema.",
    "Preserve all information. Do not summarize, omit, explain, or add Markdown fences.",
    "Return only the JSON object.",
    "",
    "Response to repair:",
    outputText,
  ].join("\n");
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        instructions: "You repair only a complete but malformed curriculum JSON response. Return schema-compliant JSON and nothing else.",
        input: repairPrompt,
        max_output_tokens: maxOutputTokens,
        text: {
          format: {
            type: "json_schema",
            name: "curriculum_lesson_analysis_repair",
            strict: true,
            schema: CURRICULUM_LESSON_SCHEMA,
          },
        },
      }),
    });
    const responseBody = await readJsonResponse(response);
    const repairedText = extractOpenAIOutputText(responseBody);
    const diagnostics = buildCurriculumResponseDiagnostics(responseBody, repairedText);
    if (!response.ok || diagnostics.truncated || diagnostics.safetyInterruption || !repairedText) {
      logger.error("OpenAI curriculum JSON repair could not complete.", {
        status: response.status,
        ...diagnostics,
      });
      return "";
    }
    return repairedText;
  } catch (error) {
    logger.error("OpenAI curriculum JSON repair request failed.", { message: error.message });
    return "";
  }
}

function getOpenAICurriculumFailureMessage(status, responseBody) {
  const error = responseBody && responseBody.error ? responseBody.error : {};
  const message = asText(error.message);
  const code = asText(error.code).toLowerCase();
  const lowerMessage = message.toLowerCase();

  if (status === 401) {
    return "OpenAI rejected the API key. Recreate the key, then update the OPENAI_API_KEY secret.";
  }

  if (status === 403 || lowerMessage.includes("permission") || lowerMessage.includes("not authorized")) {
    return "OpenAI blocked this request. Check that the key has Responses write access and access to the selected model.";
  }

  if (status === 404 || lowerMessage.includes("model")) {
    return "The selected OpenAI model is not available for this project yet. We need to switch the model setting.";
  }

  if (status === 429 || code.includes("quota") || lowerMessage.includes("quota") || lowerMessage.includes("billing")) {
    return "OpenAI billing or quota is not active for this project yet. Check the OpenAI billing and limits page.";
  }

  if (status === 400) {
    return "OpenAI did not accept the analyzer request format. I need to adjust the site code.";
  }

  if (status >= 500) {
    return "OpenAI had a temporary service problem. Try again in a few minutes.";
  }

  if (message) {
    const safeMessage = message.length > 220 ? `${message.slice(0, 217)}...` : message;
    return `OpenAI could not analyze the lesson: ${safeMessage}`;
  }

  return "OpenAI could not analyze the lesson yet. Please try again.";
}

function extractOpenAIOutputText(responseBody) {
  if (!responseBody) return "";
  if (typeof responseBody.output_text === "string") return responseBody.output_text.trim();
  if (!Array.isArray(responseBody.output)) return "";
  const parts = [];
  responseBody.output.forEach((item) => {
    if (!item || !Array.isArray(item.content)) return;
    item.content.forEach((content) => {
      if (content && typeof content.text === "string") parts.push(content.text);
      if (content && typeof content.output_text === "string") parts.push(content.output_text);
    });
  });
  return parts.join("\n").trim();
}

function parseCurriculumAnalysisOutput(outputText) {
  const text = asText(outputText).trim();
  if (!text) throw new Error("The response was empty.");

  const candidates = [
    text,
    stripCurriculumJsonFences(text),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      // Try the next safe representation before reporting a format failure.
    }
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch (error) {
      // The response may be truncated; let the caller report that clearly.
    }
  }

  throw new Error("The response did not contain a complete JSON object.");
}

function formatCurriculumStructuredValue(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return asText(value);
  const code = asText(value.code || value.standardCode || value.priorityStandardCode || value.priorityStandardNumber || value.number);
  const wording = asText(value.wording || value.officialWording || value.standardWording || value.text || value.description);
  if (code && wording) return `${code} - ${wording}`;
  if (code) return code;
  if (wording) return wording;
  try {
    return JSON.stringify(value);
  } catch (error) {
    return "";
  }
}

function normalizeCurriculumAnalysisShape(rawAnalysis, fallbackSubject) {
  if (!rawAnalysis || typeof rawAnalysis !== "object" || Array.isArray(rawAnalysis)) {
    const error = new Error("The response root must be a JSON object.");
    error.fieldErrors = ["root: expected object"];
    throw error;
  }

  const raw = rawAnalysis;
  const fieldErrors = [];
  const has = (field) => Object.prototype.hasOwnProperty.call(raw, field);
  const readString = (field, fallback = "") => {
    if (!has(field)) {
      fieldErrors.push(`${field}: missing; defaulted to an empty string`);
      return fallback;
    }
    if (typeof raw[field] === "string") return raw[field].trim();
    const converted = formatCurriculumStructuredValue(raw[field]);
    fieldErrors.push(`${field}: expected string, received ${Array.isArray(raw[field]) ? "array" : typeof raw[field]}; normalized to string`);
    return converted;
  };
  const readArray = (field) => {
    if (!has(field)) {
      fieldErrors.push(`${field}: missing; defaulted to an empty array`);
      return [];
    }
    if (Array.isArray(raw[field])) {
      return raw[field].map((item, index) => {
        if (typeof item === "string") return item.trim();
        fieldErrors.push(`${field}[${index}]: expected string, received ${typeof item}; normalized to text`);
        return formatCurriculumStructuredValue(item);
      }).filter(Boolean);
    }
    const converted = formatCurriculumStructuredValue(raw[field]);
    fieldErrors.push(`${field}: expected array, received ${typeof raw[field]}; normalized to a one-item array`);
    return converted ? [converted] : [];
  };
  const readNotes = () => {
    if (!has("standardNotes")) {
      fieldErrors.push("standardNotes: missing; defaulted to an empty string");
      return "";
    }
    if (typeof raw.standardNotes === "string") return raw.standardNotes.trim();
    if (Array.isArray(raw.standardNotes)) {
      fieldErrors.push("standardNotes: expected string, received array; joined into lines");
      return raw.standardNotes.map(formatCurriculumStructuredValue).filter(Boolean).join("\n");
    }
    const converted = formatCurriculumStructuredValue(raw.standardNotes);
    fieldErrors.push(`standardNotes: expected string, received ${typeof raw.standardNotes}; normalized to string`);
    return converted;
  };

  const priorityStandardCode = has("priorityStandardCode")
    ? readString("priorityStandardCode")
    : readString("priorityStandardNumber");
  if (!has("priorityStandardCode") && has("priorityStandardNumber")) {
    fieldErrors.push("priorityStandardCode: missing; copied from priorityStandardNumber");
  }
  const priorityStandardNumber = has("priorityStandardNumber")
    ? readString("priorityStandardNumber")
    : priorityStandardCode;
  if (!has("priorityStandardNumber") && has("priorityStandardCode")) {
    fieldErrors.push("priorityStandardNumber: missing; copied from priorityStandardCode");
  }

  const normalized = {
    subject: readString("subject", fallbackSubject),
    unitOrModule: readString("unitOrModule"),
    lessonNumber: readString("lessonNumber"),
    lessonTitle: readString("lessonTitle"),
    officialLessonTitle: readString("officialLessonTitle"),
    iCanStatement: readString("iCanStatement"),
    priorityStandardCode,
    priorityStandardNumber,
    priorityStandardWording: readString("priorityStandardWording"),
    priorityStandard: readString("priorityStandard"),
    supportingStandards: readArray("supportingStandards"),
    mathematicalPractices: readArray("mathematicalPractices"),
    standardNotes: readNotes(),
    objective: readString("objective"),
    vocabulary: readArray("vocabulary"),
    soundSpellings: readArray("soundSpellings"),
    materials: readArray("materials"),
    videoLinks: Array.isArray(raw.videoLinks) ? raw.videoLinks : [],
    parentSummary: readString("parentSummary"),
    familyQuestions: readArray("familyQuestions"),
    teacherNotes: readArray("teacherNotes"),
    missingInformation: readArray("missingInformation"),
    sourceConfidence: ["high", "medium", "low"].includes(raw.sourceConfidence) ? raw.sourceConfidence : "medium",
  };

  if (!has("videoLinks")) fieldErrors.push("videoLinks: missing; defaulted to an empty array");
  else if (!Array.isArray(raw.videoLinks)) fieldErrors.push(`videoLinks: expected array, received ${typeof raw.videoLinks}; defaulted to an empty array`);
  if (!has("sourceConfidence")) fieldErrors.push("sourceConfidence: missing; defaulted to medium");
  else if (!["high", "medium", "low"].includes(raw.sourceConfidence)) fieldErrors.push("sourceConfidence: invalid enum; defaulted to medium");

  if (fieldErrors.length) {
    logger.warn("OpenAI curriculum response shape was normalized.", {
      fieldErrors: fieldErrors.slice(0, 30),
    });
  }
  return normalized;
}

function normalizeMathStandardFields(analysis, sourceText) {
  const { codes, standardsByCode } = getMathReferenceMatches(sourceText);
  const contentCodes = codes.filter((code) => !isMathematicalPracticeCode(code));
  const practiceCodes = codes.filter(isMathematicalPracticeCode);
  const modelCodes = extractMathStandardCodes([
    analysis.priorityStandardCode,
    analysis.priorityStandardNumber,
    analysis.priorityStandard,
  ].filter(Boolean).join(" "));
  const modelPriorityCode = modelCodes.find((code) => contentCodes.includes(code));
  const priorityCode = modelPriorityCode || contentCodes[0] || "";
  const unavailableWording = "Official wording unavailable in the standards reference.";
  const getWording = (code) => {
    const standard = standardsByCode.get(code);
    return standard ? standard.officialWording : unavailableWording;
  };
  const display = (code) => `${code} - ${getWording(code)}`;
  const supportingCodes = contentCodes.filter((code) => code !== priorityCode);

  return {
    priorityStandardCode: priorityCode,
    priorityStandardNumber: priorityCode,
    priorityStandardWording: priorityCode ? getWording(priorityCode) : "",
    priorityStandard: priorityCode ? display(priorityCode) : "",
    supportingStandards: supportingCodes.map(display),
    mathematicalPractices: practiceCodes.map(display),
    standardNotes: normalizeScholarLanguage(analysis.standardNotes),
  };
}

function normalizeSkillsStandardFields(analysis, sourceText) {
  const { codes, standardsByCode } = getSkillsReferenceMatches(sourceText);
  const modelCodes = extractSkillsStandardCodes([
    analysis.priorityStandardCode,
    analysis.priorityStandardNumber,
    analysis.priorityStandard,
  ].filter(Boolean).join(" ")).map((code) => standardsByCode.get(code.toUpperCase())?.code || code);
  const modelPriorityCode = modelCodes.find((code) => codes.some((sourceCode) => sourceCode.toUpperCase() === code.toUpperCase()));
  const priorityCode = modelPriorityCode || codes[0] || "";
  const unavailableWording = "Official wording unavailable in the standards reference.";
  const getWording = (code) => {
    const standard = standardsByCode.get(asText(code).toUpperCase());
    return standard ? standard.officialWording : unavailableWording;
  };
  const display = (code) => `${code} - ${getWording(code)}`;
  const supportingCodes = codes.filter((code) => code.toUpperCase() !== priorityCode.toUpperCase());

  return {
    priorityStandardCode: priorityCode,
    priorityStandardNumber: priorityCode,
    priorityStandardWording: priorityCode ? getWording(priorityCode) : "",
    priorityStandard: priorityCode ? display(priorityCode) : "",
    supportingStandards: supportingCodes.map(display),
    mathematicalPractices: [],
    standardNotes: normalizeScholarLanguage(analysis.standardNotes),
  };
}

function normalizeCurriculumAnalysis(analysis, sourceText = "") {
  const subject = ["skills", "listening", "math", "other"].includes(analysis.subject) ? analysis.subject : "other";
  const isMath = subject === "math";
  const isSkills = subject === "skills";
  const standardFields = isMath
    ? normalizeMathStandardFields(analysis, sourceText)
    : isSkills
      ? normalizeSkillsStandardFields(analysis, sourceText)
    : {
      priorityStandardCode: "",
      priorityStandardNumber: "",
      priorityStandardWording: "",
      priorityStandard: normalizeScholarLanguage(analysis.priorityStandard),
      supportingStandards: [],
      mathematicalPractices: [],
      standardNotes: "",
    };
  const officialLessonTitle = isMath
    ? normalizeOfficialCurriculumText(analysis.officialLessonTitle || analysis.lessonTitle)
    : "";

  const normalized = {
    subject,
    unitOrModule: normalizeCurriculumUnitOrModule(analysis.unitOrModule),
    lessonNumber: normalizeScholarLanguage(analysis.lessonNumber),
    lessonTitle: isMath ? officialLessonTitle : normalizeScholarLanguage(analysis.lessonTitle),
    officialLessonTitle,
    iCanStatement: normalizeScholarLanguage(analysis.iCanStatement),
    ...standardFields,
    objective: normalizeScholarLanguage(analysis.objective),
    vocabulary: normalizeScholarLanguageArray(analysis.vocabulary),
    soundSpellings: normalizeScholarLanguageArray(analysis.soundSpellings),
    materials: normalizeScholarLanguageArray(analysis.materials),
    videoLinks: normalizeVideoLinks(analysis.videoLinks),
    parentSummary: normalizeScholarLanguage(analysis.parentSummary),
    familyQuestions: normalizeScholarLanguageArray(analysis.familyQuestions),
    teacherNotes: normalizeScholarLanguageArray(analysis.teacherNotes),
    missingInformation: normalizeScholarLanguageArray(analysis.missingInformation),
    sourceConfidence: ["high", "medium", "low"].includes(analysis.sourceConfidence) ? analysis.sourceConfidence : "medium",
  };
  normalized.missingInformation = normalizeCurriculumMissingInformation(normalized);
  return normalized;
}

function extractExplicitCurriculumSightWords(sourceText) {
  const text = asText(sourceText).replace(/\s+/g, " ");
  const segments = [];
  const markedListMatch = text.match(/\bSIGHT_WORDS_BEGIN\b\s*(.*?)\s*\bSIGHT_WORDS_END\b/i);
  const combinedHeadingMatch = text.match(/\bSight\s+Words?\s*\/\s*Tricky\s+Words?\s*:?\s*(.*?)(?=\b(?:Sounds(?:\s+and\s+Spellings)?|Vocabulary|Unit\s+Description|Note)\b|\bCKLA\s+Grade\b|$)/i);
  const introductionMatch = text.match(/\bfollowing\s+Tricky\s+Words?\s*:\s*([^\.]{1,700})/i);
  let match;
  if (markedListMatch) {
    segments.push(markedListMatch[1]);
  } else if (combinedHeadingMatch) {
    segments.push(combinedHeadingMatch[1]);
  } else if (introductionMatch) {
    segments.push(introductionMatch[1]);
  } else {
    const labeledPattern = /\b(?:Tricky|Sight|High[-\s]?Frequency)\s+Words?\s*:\s*([^\.]{1,300})/gi;
    while ((match = labeledPattern.exec(text)) !== null) segments.push(match[1]);

    const singleTrickyWordPattern = /\bTricky\s+Word\s*:\s*([A-Za-z]+(?:['’-][A-Za-z]+)?)/gi;
    while ((match = singleTrickyWordPattern.exec(text)) !== null) segments.push(match[1]);
  }

  const ignoredLabels = new Set(["tricky", "sight", "high", "frequency", "cards", "card", "practice", "review"]);
  const words = [];
  segments.forEach(segment => {
    const listText = String(segment || "")
      .split(/\s*;\s*(?:grammar|sounds?|spellings?|objectives?|materials?)\s*:/i)[0]
      .replace(/[“”‘’]/g, "")
      .replace(/\s+and\s+/gi, ",");
    listText.split(/\s*,\s*/).forEach(candidate => {
      const word = candidate.trim().replace(/^[^A-Za-z]+|[^A-Za-z'’-]+$/g, "");
      if (!word || !/^[A-Za-z]+(?:['’-][A-Za-z]+)?$/.test(word)) return;
      if (ignoredLabels.has(word.toLowerCase())) return;
      words.push(word);
    });
  });

  const seen = new Set();
  return words.filter(word => {
    const key = word.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeCurriculumUnitAnalysis(analysis, sourceText = "") {
  const explicitSightWords = extractExplicitCurriculumSightWords(sourceText);
  return {
    unitTitle: normalizeScholarLanguage(analysis.unitTitle),
    priorityStandard: normalizeScholarLanguage(analysis.priorityStandard),
    iCanStatement: normalizeScholarLanguage(analysis.iCanStatement),
    description: normalizeScholarLanguage(analysis.description),
    soundSpellings: normalizeScholarLanguageArray(analysis.soundSpellings).slice(0, 20),
    sightWords: (explicitSightWords.length ? explicitSightWords : normalizeScholarLanguageArray(analysis.sightWords)).slice(0, 40),
    vocabulary: normalizeScholarLanguageArray(analysis.vocabulary).slice(0, 20),
    strategies: normalizeScholarLanguageArray(analysis.strategies).slice(0, 20),
    sourceConfidence: ["high", "medium", "low"].includes(analysis.sourceConfidence) ? analysis.sourceConfidence : "medium",
  };
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asText(item)).filter(Boolean);
}

function normalizeScholarLanguage(value) {
  return asText(value).replace(/\b(student|students|child|children|kid|kids)\b/gi, (match) => {
    const replacement = /^(student|child|kid)$/i.test(match) ? "scholar" : "scholars";
    return /^[A-Z]/.test(match) ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
  });
}

function normalizeCurriculumUnitOrModule(value) {
  return asText(value)
    .replace(/\s+/g, " ")
    .replace(/\b(?:m|mod|module)\s*[:#-]?\s*([0-9]+[A-Za-z]?)\b/gi, "Module $1")
    .replace(/\b(?:u|unit)\s*[:#-]?\s*([0-9]+[A-Za-z]?)\b/gi, "Unit $1")
    .trim();
}

function normalizeScholarLanguageArray(value) {
  return normalizeStringArray(value).map(normalizeScholarLanguage);
}

function normalizeOfficialCurriculumText(value) {
  return asText(value).replace(/\s+/g, " ").trim();
}

function normalizeOfficialCurriculumArray(value) {
  return normalizeStringArray(value).map(normalizeOfficialCurriculumText).filter(Boolean);
}

function normalizeCurriculumMissingInformation(analysis) {
  return normalizeStringArray(analysis.missingInformation).filter((item) => {
    const text = item.toLowerCase();
    if (analysis.iCanStatement && (text.includes("i can") || text.includes("student-facing") || text.includes("scholar-facing"))) return false;
    if (analysis.priorityStandard && text.includes("priority standard") && (text.includes("single") || text.includes("identify"))) return false;
    if (analysis.vocabulary.length && (text.includes("vocabulary") || text.includes("vocab"))) return false;
    if (analysis.familyQuestions.length && (text.includes("family") || text.includes("discussion question"))) return false;
    return true;
  });
}

function normalizeVideoLinks(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    title: normalizeScholarLanguage(item && item.title) || "Video",
    url: asText(item && item.url),
    note: normalizeScholarLanguage(item && item.note),
  })).filter((item) => item.title || item.url || item.note);
}

function readableDate(value) {
  if (!value) return "";

  if (typeof value.toDate === "function") {
    return value.toDate().toLocaleString("en-US", { timeZone: "America/Chicago" });
  }

  if (typeof value === "string") {
    return value;
  }

  return "";
}

function asText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function escapeHtml(value) {
  return asText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
