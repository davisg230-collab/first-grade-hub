const { logger } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const MAIL_COLLECTION = process.env.MAIL_COLLECTION || "mail";
const APPROVED_EDITOR_EMAILS = new Set([
  "davisg230@gmail.com",
  "lvest@crossroadsschoolskc.org",
]);
const DEFAULT_TEACHER_EMAILS = [
  "dgonzalezjr@crossroadsschoolskc.org",
  "lvest@crossroadsschoolskc.org",
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
      subject: asText(data.subject),
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
            "Always refer to the children in the class as scholars. Never use student, students, child, children, kid, or kids in any generated field; use scholar or scholars instead.",
          ].join(" "),
          input: prompt,
          max_output_tokens: 2200,
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
      });
      throw new HttpsError("failed-precondition", getOpenAICurriculumFailureMessage(response.status, responseBody));
    }

    const outputText = extractOpenAIOutputText(responseBody);
    if (!outputText) {
      logger.error("OpenAI curriculum response had no output text.", { responseId: responseBody && responseBody.id });
      throw new HttpsError("internal", "The AI analyzer did not return a usable draft.");
    }

    let analysis;
    try {
      analysis = JSON.parse(outputText);
    } catch (error) {
      logger.error("OpenAI curriculum response was not valid JSON.", { message: error.message });
      throw new HttpsError("internal", "The AI analyzer returned a draft in the wrong format.");
    }

    return {
      analysis: normalizeCurriculumAnalysis(analysis),
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
    iCanStatement: { type: "string" },
    priorityStandard: { type: "string" },
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
    "iCanStatement",
    "priorityStandard",
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

function buildCurriculumAnalysisPrompt(data) {
  return [
    "Analyze this first grade curriculum lesson for a teacher-facing lesson library.",
    "",
    `Subject selected by teacher: ${data.subject || "not provided"}`,
    `Unit/module selected by teacher: ${data.unitOrModule || "not provided"}`,
    `Lesson number selected by teacher: ${data.lessonNumber || "not provided"}`,
    `Lesson title selected by teacher: ${data.lessonTitle || "not provided"}`,
    "",
    "Return the exact structured fields requested by the schema.",
    "For lessonTitle, look first at the objective or main learning goal and create a short 3-7 word lesson name that says what scholars are learning. Use the printed lesson title only if it is already clear and specific. Never use file names, guide names, internal labels, or generic titles like \"Lesson 1\". Good examples: \"Sounds p, k, g, n, a\", \"Counting On to Add\", \"Retelling Key Story Events\".",
    "For priorityStandard, identify the one main standard focus for the lesson, or two if the lesson genuinely has two equal main goals. Prefer standards listed in the source, choosing the one or two that best match the lesson's main teaching point. If the source provides no standard codes, write the main standard skill in plain language instead of inventing a code.",
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

function normalizeCurriculumAnalysis(analysis) {
  const normalized = {
    subject: ["skills", "listening", "math", "other"].includes(analysis.subject) ? analysis.subject : "other",
    unitOrModule: normalizeScholarLanguage(analysis.unitOrModule),
    lessonNumber: normalizeScholarLanguage(analysis.lessonNumber),
    lessonTitle: normalizeScholarLanguage(analysis.lessonTitle),
    iCanStatement: normalizeScholarLanguage(analysis.iCanStatement),
    priorityStandard: normalizeScholarLanguage(analysis.priorityStandard),
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

function normalizeScholarLanguageArray(value) {
  return normalizeStringArray(value).map(normalizeScholarLanguage);
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
