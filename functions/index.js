const fs = require("fs");
const path = require("path");
const { logger } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const MATH_STANDARDS_REFERENCE_PATH = path.join(__dirname, "data", "math-standards-reference.json");
const SKILLS_STANDARDS_REFERENCE_PATH = path.join(__dirname, "data", "skills-standards-reference.json");
let mathStandardsReferenceCache;
let skillsStandardsReferenceCache;
const KINDERGARTEN_MATH_SUBJECT = "kindergarten-math";
const CURRICULUM_LESSON_SUBJECTS = ["skills", "listening", "math", KINDERGARTEN_MATH_SUBJECT, "other"];
const CURRICULUM_PLAN_SUBJECTS = ["skills", "listening", "math"];
const CURRICULUM_DEFAULT_LESSON_SOURCE_LIMIT = 20000;
const CURRICULUM_LONG_SINGLE_LESSON_SOURCE_LIMIT = 45000;
const HUB_PUBLIC_URL = "https://first-grade-news-hub-mrdavis.web.app/";
const CURRICULUM_RECOMMENDATION_ALLOWED_ORIGINS = new Set([
  "https://firstgradelearninggames.web.app",
  "https://first-grade-news-hub-mrdavis.web.app",
]);
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
    const unitOrModule = asText(data.unitOrModule);
    const lessonNumber = asText(data.lessonNumber);
    const lessonTitle = asText(data.lessonTitle);
    const selectedPriorityStandard = getTeacherSelectedPriorityStandard(data);
    const sourceText = asText(data.sourceText);
    if (sourceText.length < 40) {
      throw new HttpsError("invalid-argument", "Paste one full lesson before running the AI analyzer.");
    }
    const sourceLimit = getCurriculumLessonSourceLimit(subject, sourceText, lessonNumber);
    if (sourceText.length > sourceLimit) {
      throw new HttpsError(
        "invalid-argument",
        sourceLimit > CURRICULUM_DEFAULT_LESSON_SOURCE_LIMIT
          ? "That lesson text is still too long for one AI draft. Trim extra pages or duplicate teacher-guide sections, then try again."
          : "Paste one lesson at a time so the AI request stays focused and low-cost."
      );
    }

    const apiKey = OPENAI_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "The OpenAI API key is not configured yet.");
    }

    const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
    const prompt = buildCurriculumAnalysisPrompt({
      subject,
      unitOrModule,
      lessonNumber,
      lessonTitle,
      selectedPriorityStandard,
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
            "You are a careful elementary curriculum assistant for first grade and Kindergarten lessons.",
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
          max_output_tokens: isMathCurriculumSubject(subject) ? 6000 : 2200,
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
          maxOutputTokens: isMathCurriculumSubject(subject) ? 6000 : 2200,
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
      analysis: normalizeCurriculumAnalysis(analysis, sourceText, { selectedPriorityStandard }),
      analyzedAt: new Date().toISOString(),
      model,
    };
  }
);

exports.analyzeCurriculumPlan = onCall(
  {
    secrets: [OPENAI_API_KEY],
    timeoutSeconds: 120,
    memory: "512MiB",
  },
  async (request) => {
    const email = asText(request.auth && request.auth.token && request.auth.token.email).toLowerCase();
    if (!APPROVED_EDITOR_EMAILS.has(email)) {
      throw new HttpsError("permission-denied", "Teacher sign-in is required to analyze curriculum plans.");
    }

    const data = request.data || {};
    const subject = normalizeCurriculumPlanSubject(data.subject);
    const sourceText = asText(data.sourceText);
    if (sourceText.length < 40) {
      throw new HttpsError("invalid-argument", "Upload or paste one complete lesson before running the Plan Analyzer.");
    }
    if (sourceText.length > 22000) {
      throw new HttpsError("invalid-argument", "Trim the lesson text to one lesson before running the Plan Analyzer.");
    }

    const apiKey = OPENAI_API_KEY.value();
    if (!apiKey) {
      throw new HttpsError("failed-precondition", "The OpenAI API key is not configured yet.");
    }

    const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
    const toggleSettings = normalizeCurriculumPlanToggleSettings(data.toggleSettings);
    const prompt = buildCurriculumPlanPrompt({
      subject,
      unitOrModule: asText(data.unitOrModule),
      lessonNumber: asText(data.lessonNumber),
      lessonTitle: asText(data.lessonTitle),
      priorityStandard: asText(data.priorityStandard),
      sourceText,
      toggleSettings,
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
            "You are a careful first grade planning assistant.",
            "Your job is to turn a curriculum lesson into a classroom-block plan for how Mr. Davis's class actually runs.",
            "Do not merely summarize the lesson. Adapt it into the fixed block structure named in the prompt.",
            "Use only facts, pages, materials, vocabulary, story content, problems, worksheets, and lesson ideas supported by the source.",
            "When you infer practical directions, make them teacher-useful and substitute-friendly without inventing unsupported curriculum facts.",
            "Always refer to children as scholars in newly written fields.",
            "Do not generate sections that the teacher turned off in the toggle settings.",
            "The Principal View must be a shorter view derived from the same plan, not a separate unrelated plan.",
          ].join(" "),
          input: prompt,
          max_output_tokens: subject === "listening" ? 4500 : 9000,
          text: {
            format: {
              type: "json_schema",
              name: "curriculum_plan_analysis",
              strict: true,
              schema: CURRICULUM_PLAN_SCHEMA,
            },
          },
        }),
      });
    } catch (error) {
      logger.error("OpenAI curriculum plan request failed before response.", { message: error.message });
      throw new HttpsError("unavailable", "The AI service could not be reached. Please try again.");
    }

    const responseBody = await readJsonResponse(response);
    if (!response.ok) {
      const openAiError = responseBody && responseBody.error ? responseBody.error : {};
      logger.error("OpenAI curriculum plan request failed.", {
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
      logger.error("OpenAI curriculum plan response was incomplete.", responseDiagnostics);
      throw new HttpsError("internal", "The AI plan draft was cut off before it finished. Please try analyzing this lesson again.");
    }
    if (!outputText) {
      logger.error("OpenAI curriculum plan response had no output text.", responseDiagnostics);
      throw new HttpsError("internal", "The Plan Analyzer did not return a usable draft.");
    }

    let analysis;
    try {
      analysis = parseCurriculumAnalysisOutput(outputText);
      analysis = normalizeCurriculumPlanAnalysis(analysis, {
        subject,
        unitOrModule: asText(data.unitOrModule),
        lessonNumber: asText(data.lessonNumber),
        lessonTitle: asText(data.lessonTitle),
        sourceText,
        toggleSettings,
      });
    } catch (error) {
      logger.error("OpenAI curriculum plan response failed normalization.", {
        ...buildCurriculumResponseDiagnostics(responseBody, outputText, error),
      });
      throw new HttpsError("internal", "The AI plan draft could not be normalized. Please try analyzing the lesson again.");
    }

    return {
      analysis,
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

exports.recommendCurriculumLessons = onRequest(
  {
    timeoutSeconds: 30,
    memory: "256MiB",
  },
  async (request, response) => {
    setCurriculumRecommendationCorsHeaders(request, response);

    if (request.method === "OPTIONS") {
      response.status(204).send("");
      return;
    }

    if (!["GET", "POST"].includes(request.method)) {
      response.status(405).json({ error: "Use GET or POST to request curriculum recommendations." });
      return;
    }

    try {
      const data = getCurriculumRecommendationRequestData(request);
      const needs = normalizeCurriculumRecommendationNeeds(data.needs);
      const subject = normalizeCurriculumRecommendationSubject(data.subject);
      const limit = normalizeCurriculumRecommendationLimit(data.limit);

      if (!needs.length) {
        response.status(400).json({ error: "Send at least one skill or need to match against the Curriculum Library." });
        return;
      }

      const snapshot = await admin.firestore().collection("curriculumLessons").limit(700).get();
      const recommendations = snapshot.docs
        .map((doc) => {
          const lesson = doc.data() || {};
          const match = scoreCurriculumRecommendationLesson(lesson, needs, subject);
          if (!match.score) return null;
          return buildCurriculumRecommendationPayload(doc.id, lesson, match);
        })
        .filter(Boolean)
        .sort((a, b) =>
          b.score - a.score
          || a.subjectLabel.localeCompare(b.subjectLabel)
          || a.unitOrModule.localeCompare(b.unitOrModule)
          || getLessonNumberValue(a.lessonNumber) - getLessonNumberValue(b.lessonNumber)
          || a.lessonTitle.localeCompare(b.lessonTitle)
        )
        .slice(0, limit);

      response.status(200).json({
        needs,
        subject,
        count: recommendations.length,
        recommendations,
      });
    } catch (error) {
      logger.error("Curriculum recommendation lookup failed.", {
        message: error && error.message,
      });
      response.status(500).json({ error: "Curriculum recommendations could not load yet." });
    }
  }
);

const CURRICULUM_LESSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: { type: "string", enum: CURRICULUM_LESSON_SUBJECTS },
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

const CURRICULUM_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: { type: "string", enum: CURRICULUM_PLAN_SUBJECTS },
    unitOrModule: { type: "string" },
    lessonNumber: { type: "string" },
    lessonTitle: { type: "string" },
    planTitle: { type: "string" },
    priorityStandard: { type: "string" },
    iCanStatement: { type: "string" },
    teacherSubView: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["key", "title", "body"],
      },
    },
    principalView: {
      type: "object",
      additionalProperties: false,
      properties: {
        teacherDoing: { type: "string" },
        scholarsDoing: { type: "string" },
        rotationBullets: { type: "array", items: { type: "string" } },
        evidenceCollected: { type: "string" },
        interventionOverview: { type: "string" },
      },
      required: [
        "teacherDoing",
        "scholarsDoing",
        "rotationBullets",
        "evidenceCollected",
        "interventionOverview",
      ],
    },
    missingInformation: { type: "array", items: { type: "string" } },
    sourceConfidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: [
    "subject",
    "unitOrModule",
    "lessonNumber",
    "lessonTitle",
    "planTitle",
    "priorityStandard",
    "iCanStatement",
    "teacherSubView",
    "principalView",
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

function normalizeSkillsStandardLookupCode(code) {
  return asText(code).replace(/\.([A-Za-z])$/, "$1");
}

function extractSkillsStandardCodes(sourceText) {
  const matches = asText(sourceText).match(/\b(?:RL|RF|RI|SL|L)\.\d+\.\d+(?:\.?[a-z])?\b/gi) || [];
  return Array.from(new Set(matches.map(normalizeSkillsStandardLookupCode).filter(Boolean)));
}

function getSkillsReferenceMatches(sourceText) {
  const reference = loadSkillsStandardsReference();
  const standardsByCode = new Map(reference.standards.map((standard) => [standard.code.toUpperCase(), standard]));
  const codes = Array.from(new Set(extractSkillsStandardCodes(sourceText).map((code) => {
    const normalizedCode = normalizeSkillsStandardLookupCode(code);
    const standard = standardsByCode.get(normalizedCode.toUpperCase());
    return standard ? standard.code : normalizedCode;
  })));
  return {
    codes,
    matches: codes.map((code) => standardsByCode.get(code.toUpperCase()) || null),
    standardsByCode,
  };
}

function normalizeSkillsStandardCode(code, standardsByCode) {
  const text = normalizeSkillsStandardLookupCode(code);
  return standardsByCode.get(text.toUpperCase())?.code || text;
}

function uniqueSkillsStandardCodes(codes) {
  const seen = new Set();
  return codes.filter((code) => {
    const key = asText(code).toUpperCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isMoreSpecificSkillsStandardCode(candidate, parent) {
  const childCode = asText(candidate).toUpperCase();
  const parentCode = asText(parent).toUpperCase();
  return childCode.length === parentCode.length + 1
    && childCode.startsWith(parentCode)
    && /^[A-Z]$/.test(childCode.slice(-1));
}

function selectSkillsPriorityCodes(modelCodes, sourceCodes) {
  const selectedCodes = uniqueSkillsStandardCodes(modelCodes)
    .map((code) => sourceCodes.find((sourceCode) => sourceCode.toUpperCase() === code.toUpperCase()) || "")
    .filter(Boolean);
  const initialCodes = selectedCodes.length ? selectedCodes : sourceCodes.slice(0, 1);
  const expandedCodes = initialCodes.flatMap((code) => {
    const specificChildren = sourceCodes.filter((sourceCode) => isMoreSpecificSkillsStandardCode(sourceCode, code));
    return specificChildren.length === 1 ? specificChildren : [code];
  });
  return uniqueSkillsStandardCodes(expandedCodes)
    .filter((code, index, codes) => !codes.some((otherCode, otherIndex) => (
      otherIndex !== index && isMoreSpecificSkillsStandardCode(otherCode, code)
    )))
    .slice(0, 2);
}

function buildSkillsStandardsContext(sourceText, label = "Skills") {
  const { codes, matches } = getSkillsReferenceMatches(sourceText);
  const article = /^[AEIOU]/i.test(label) ? "an" : "a";
  if (!codes.length) {
    return [
      `Local ${label} standards reference lookup: no ${label} standard code was found in the lesson source.`,
      `Do not invent ${article} ${label} standard code or official wording.`,
    ].join("\n");
  }

  const lines = [
    `Local ${label} standards reference lookup for cited codes: ${codes.join(", ")}`,
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

function isMathCurriculumSubject(subject) {
  return subject === "math" || subject === KINDERGARTEN_MATH_SUBJECT;
}

function isKindergartenMathSubject(subject) {
  return subject === KINDERGARTEN_MATH_SUBJECT;
}

function getTeacherSelectedPriorityStandard(data = {}) {
  const visibleStandard = asText(data.priorityStandard);
  if (visibleStandard) return visibleStandard;
  return [
    asText(data.priorityStandardCode || data.priorityStandardNumber),
    asText(data.priorityStandardWording),
  ].filter(Boolean).join(" - ");
}

function getCurriculumLessonSourceLimit(subject, sourceText, lessonNumber = "") {
  if ((subject === "listening" || isMathCurriculumSubject(subject))
    && looksLikeSingleCurriculumLessonText(sourceText, lessonNumber)) {
    return CURRICULUM_LONG_SINGLE_LESSON_SOURCE_LIMIT;
  }
  return CURRICULUM_DEFAULT_LESSON_SOURCE_LIMIT;
}

function looksLikeSingleCurriculumLessonText(sourceText, lessonNumber = "") {
  const text = asText(sourceText).slice(0, 60000);
  const lessonTokens = extractCurriculumLessonNumberTokens(text);
  if (lessonTokens.length <= 1) return true;

  const selectedToken = extractCurriculumLessonNumberTokens(lessonNumber)[0] || "";
  const distinctTokens = Array.from(new Set(lessonTokens));
  if (distinctTokens.length === 1) return true;

  if (selectedToken) {
    const otherTokenCount = lessonTokens.filter((token) => token !== selectedToken).length;
    const firstToken = lessonTokens[0] || "";
    if (firstToken === selectedToken && otherTokenCount <= 2) return true;
  }

  const counts = lessonTokens.reduce((map, token) => {
    map.set(token, (map.get(token) || 0) + 1);
    return map;
  }, new Map());
  const mostCommonCount = Math.max(...Array.from(counts.values()));
  if (mostCommonCount >= Math.max(3, lessonTokens.length - 1)) return true;

  return false;
}

function extractCurriculumLessonNumberTokens(value) {
  const text = asText(value).replace(/[\u2010-\u2015]/g, "-");
  const tokens = [];
  for (const match of text.matchAll(/\blesson\s*(?:number|no\.?|#|:|-)?\s*([0-9]{1,3}[A-Za-z]?)(?!\s*-\s*[0-9])/gi)) {
    tokens.push(String(match[1] || "").toLowerCase());
  }
  return tokens;
}

function normalizeCurriculumPlanSubject(subject) {
  return CURRICULUM_PLAN_SUBJECTS.includes(subject) ? subject : "skills";
}

function getCurriculumPlanToggleLabels() {
  return {
    teacherScript: "Teacher Script",
    materials: "Materials",
    pageNumbers: "Page Numbers",
    groupA: "Group A Tasks",
    groupB: "Group B Tasks",
    groupC: "Group C Tasks",
    handwriting: "Handwriting",
    reading: "Reading",
    writing: "Writing",
    learningGames: "Learning Games / Data Check",
    guidedWork: "Guided Work",
    independentEvidence: "Independent Evidence",
    intervention: "Intervention Work",
    extensions: "Extensions",
  };
}

function normalizeCurriculumPlanToggleSettings(value) {
  const labels = getCurriculumPlanToggleLabels();
  return Object.keys(labels).reduce((settings, key) => {
    settings[key] = !(value && value[key] === false);
    return settings;
  }, {});
}

function getCurriculumPlanSelectedToggleLabels(toggleSettings) {
  const labels = getCurriculumPlanToggleLabels();
  return Object.keys(labels)
    .filter((key) => toggleSettings[key] !== false)
    .map((key) => labels[key]);
}

function getCurriculumPlanDisabledToggleLabels(toggleSettings) {
  const labels = getCurriculumPlanToggleLabels();
  return Object.keys(labels)
    .filter((key) => toggleSettings[key] === false)
    .map((key) => labels[key]);
}

function buildCurriculumPlanStructureGuidance(subject) {
  if (isMathCurriculumSubject(subject)) {
    return [
      "Math fixed rotations:",
      "Rotation 1: A/B Lesson Station, C review/Learning Games.",
      "Rotation 2: A Worksheet Station, B Learning Games/application, C Lesson Station.",
      "Rotation 3: A independent application/Learning Games, B/C Guided Work.",
      "Rotation 4: Math Closing + Exit Ticket.",
      "Rotation 5: Math Intervention.",
      "",
      "Read the uploaded math lesson and decide what parts the teacher should actually teach, exact teacher directions, page numbers, materials, Group A independent work, Group B independent work, Group C support, quick Learning Game/data-check tasks, worksheet/problem-set expectations, extension/application for A, guided-work focus for B/C, what to watch for, closing/debrief, exit ticket use, and what non-intervention scholars do during Math Intervention.",
      "The Teacher/Sub View must be chronological: Rotation 1, Rotation 2, Rotation 3, Rotation 4, Rotation 5. Put worksheet work, game checks, guided work, independent evidence, extensions, and intervention tasks inside the rotation where they happen, not as separate repeated sections.",
    ].join("\n");
  }
  if (subject === "listening") {
    return [
      "Listening & Learning plan structure:",
      "Create a focused story/content plan with title, page numbers, materials, vocabulary, brief teacher script, important places to stop and ask questions, comprehension focus, short discussion, and short response/activity based specifically on that story or content.",
      "This plan is separate from Skills and Math. Do not create a second pacing system.",
    ].join("\n");
  }
  return [
    "Skills fixed rotations:",
    "Rotation 1: A/B Lesson Station, C independent review.",
    "Rotation 2: A worksheet/handwriting, B independent literacy/data check, C Lesson Station.",
    "Rotation 3: A independent literacy/data check, B/C Guided Work.",
    "Reading Intervention (11:30-12:00): teacher works with the selected UFLI small group; other scholars complete exact independent lesson-aligned work, book-bag/free-choice reading, and a short response prompt.",
    "",
    "Only build Rotations 1-3 from the Skills lesson. Listening & Learning is analyzed separately and supplies Rotations 4-5 when plans are viewed together.",
    "Read the uploaded Skills lesson for lesson content and skill focus, then use the teacher's classroom-block routine to generate the activities needed to fill the block. The activities do not have to appear word-for-word in the curriculum PDF; they must be appropriate for the lesson content and priority standard.",
    "Generate lesson-specific planning details when the toggles are on: a 2-3 question data check, lesson-based handwriting practice, exact independent literacy tasks, a short writing/application activity, book-bag/free-choice reading directions with a short response prompt, independent work for scholars not in the UFLI group during Reading Intervention, and lesson-aligned extensions.",
    "The Teacher/Sub View must be chronological: Rotation 1, Rotation 2, Rotation 3, then Reading Intervention (11:30-12:00). Put handwriting, reading, writing, game checks, guided work, independent evidence, and extensions inside the rotation where they happen. Keep Reading Intervention as its own section after Rotation 3 instead of burying it inside Rotation 3.",
  ].join("\n");
}

function buildCurriculumPlanPrompt(data) {
  const subjectLabel = labelForCurriculumSubject(data.subject);
  const selectedToggleLabels = getCurriculumPlanSelectedToggleLabels(data.toggleSettings);
  const disabledToggleLabels = getCurriculumPlanDisabledToggleLabels(data.toggleSettings);
  const priorityStandard = asText(data.priorityStandard);
  const standardsContext = isMathCurriculumSubject(data.subject)
    ? buildMathStandardsContext(`${priorityStandard}\n${data.sourceText}`)
    : "";
  return [
    `Create a first grade ${subjectLabel} Plan Analyzer draft.`,
    "",
    "Core idea: the teacher uploads a lesson PDF, but you are analyzing this lesson inside the teacher's actual classroom block, not just summarizing the lesson itself.",
    "",
    `Plan type selected by teacher: ${subjectLabel}`,
    `Unit/module selected by teacher: ${data.unitOrModule || "not provided"}`,
    `Lesson number selected by teacher: ${data.lessonNumber || "not provided"}`,
    `Lesson title selected by teacher: ${data.lessonTitle || "not provided"}`,
    `Priority standard selected by teacher: ${priorityStandard || "not provided"}`,
    "",
    buildCurriculumPlanStructureGuidance(data.subject),
    ...(standardsContext ? ["", standardsContext] : []),
    "",
    "Teacher toggle settings:",
    `Generate these sections/details from the uploaded lesson content plus the classroom routine when their toggles are on: ${selectedToggleLabels.join(", ") || "none"}.`,
    disabledToggleLabels.length
      ? `Do not generate standalone sections or details for: ${disabledToggleLabels.join(", ")}.`
      : "No sections are turned off.",
    "",
    "Return teacherSubView as editable sections. Use clear section titles. Include the fixed rotation sections for Skills and Math. For Listening & Learning, include practical story/content sections rather than rotations unless the source clearly has lesson segments.",
    "Each teacherSubView body should be detailed enough that the teacher or a substitute could teach from it without reopening the teacher guide unless needed.",
    "The selected priorityStandard field must guide what the plan emphasizes, what evidence/data is collected, and what intervention or independent work is assigned. Copy the selected priority standard into priorityStandard unless the teacher left it blank.",
    "Behave like a classroom planner, not a source checker. The PDF provides the lesson content and skills; the saved classroom-block settings provide the routine. Combine both to create the lesson-aligned classroom activities needed to fill the block.",
    "You are allowed to generate a 2-3 question lesson-specific data check, lesson-based handwriting practice, exact independent literacy tasks, a short writing/application activity, book-bag/free-choice reading directions with a short response prompt, independent work for scholars not in the UFLI group, and lesson-aligned extensions. These activities do not have to appear word-for-word in the curriculum PDF.",
    "Do not write vague placeholders or source-checking refusals such as \"if available,\" \"use assigned work,\" \"the source does not provide a data-check form,\" \"do not assign an invented response,\" or \"the teacher must supply intervention work.\" Name the exact lesson-aligned task, question, response, page/checkpoint, or evidence source you created from the lesson content and priority standard.",
    "Make Principal View much shorter and derived from the same teacherSubView plan: title/I Can lives in the top fields; then teacherDoing, scholarsDoing, brief rotationBullets, evidenceCollected, and interventionOverview.",
    "Use page numbers only when the source provides or strongly implies them. If exact pages are unclear and Page Numbers is on, say what page range/source location to check rather than inventing numbers.",
    "Return missingInformation as an empty array unless something is genuinely required before the plan can be used, such as unreadable lesson text, a missing lesson objective, contradictory source content, or an essential page/image that cannot be inferred. Do not use missingInformation for normal planning gaps that you can solve from the lesson content, priority standard, and classroom routine.",
    "",
    "Lesson source:",
    data.sourceText,
  ].join("\n");
}

function buildCurriculumAnalysisPrompt(data) {
  const isMath = isMathCurriculumSubject(String(data.subject || "").trim().toLowerCase());
  const isKindergartenMath = isKindergartenMathSubject(String(data.subject || "").trim().toLowerCase());
  const isSkills = String(data.subject || "").trim().toLowerCase() === "skills";
  const isListening = String(data.subject || "").trim().toLowerCase() === "listening";
  const selectedPriorityStandard = asText(data.selectedPriorityStandard);
  const titleAndStandardGuidance = isMath
    ? [
      `This is a ${isKindergartenMath ? "KINDERGARTEN MATH" : "MATH"} lesson. officialLessonTitle is an extraction field, not a generation field. If the source contains an official lesson title, copy it exactly into both lessonTitle and officialLessonTitle, including its wording, numbering, punctuation, and capitalization. Do not shorten, summarize, paraphrase, or replace it with a title based on the objective. If no official title is available, leave both title fields empty rather than inventing a title.`,
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
        "This is a SKILLS lesson. When the source cites a standard code such as RF.1.2b, return the exact code in priorityStandardCode and priorityStandardNumber. Choose the most specific content standard that represents the newly introduced or explicitly taught skill as the priority standard and put other cited content-standard codes separately in supportingStandards.",
        "Use the lesson objective and the instructional focus together to choose Skills priority standards. Do not choose priority standards by keyword frequency alone.",
        "Broader prerequisite, application, review, fluency, and comprehension standards should remain supporting standards unless that broader skill is itself the explicit new teaching focus.",
        "If the lesson explicitly introduces two distinct major Skills standards, return both compact codes in priorityStandardCode and priorityStandardNumber separated by a comma. Do not return more than two priority standards.",
        "The permanent Skills standards reference is authoritative for official wording. Return compact standard codes in the code fields; the server will fill priorityStandardWording, priorityStandard, and supportingStandards with the exact reference wording. Do not invent a code or rewrite official wording.",
        "If a cited Skills code is not in the permanent reference, preserve the code and let the server display Official wording unavailable in the standards reference.",
        "For standardNotes, write one short line per cited code explaining how this lesson addresses that standard. Do not repeat or rewrite the official wording in these notes.",
        "For non-math-only fields officialLessonTitle, priorityStandardCode, priorityStandardNumber, priorityStandardWording, supportingStandards, mathematicalPractices, and standardNotes, return empty values when they do not apply.",
      ]
    : isListening
      ? [
        "This is a LISTENING & LEARNING lesson. When the source cites an ELA standard code such as RL.1.1, RI.1.2, SL.1.4, or L.1.6, return the exact compact code in priorityStandardCode and priorityStandardNumber.",
        "Choose the one comprehension, knowledge-building, vocabulary, or speaking/listening standard most directly assessed by the lesson as the priority standard. Put other cited ELA standard codes separately in supportingStandards.",
        "The permanent ELA standards reference is authoritative for official wording. Return compact standard codes in the code fields; the server will fill priorityStandardWording, priorityStandard, and supportingStandards with the exact reference wording. Do not invent a code or rewrite official wording.",
        "If the source provides no standard code, write the main Listening & Learning standard focus in plain language in priorityStandard and leave priorityStandardCode and priorityStandardNumber empty.",
        "For standardNotes, write one short line per cited code explaining how this lesson addresses that standard. Do not repeat or rewrite the official wording in these notes.",
        "For Listening & Learning, treat the read-aloud, vocabulary, discussion, checks, and application activity as parts of one lesson when they share the same lesson number or title. Do not tell the teacher to trim the source unless it clearly includes multiple distinct lesson numbers or lesson titles.",
        "For math-only fields officialLessonTitle and mathematicalPractices, return empty values.",
      ]
    : [
      "For non-math lessons, look first at the objective or main learning goal and create a short 3-7 word lesson name that says what scholars are learning. Use the printed lesson title only if it is already clear and specific. Never use file names, guide names, internal labels, or generic titles like \"Lesson 1\".",
      "For non-math lessons, set officialLessonTitle, priorityStandardCode, priorityStandardNumber, priorityStandardWording, supportingStandards, mathematicalPractices, and standardNotes to empty values unless the source clearly supplies those separate fields.",
      "For priorityStandard, identify the one main standard focus for the lesson, or two if the lesson genuinely has two equal main goals. Prefer standards listed in the source, choosing the one or two that best match the lesson's main teaching point. If the source provides no standard codes, write the main standard skill in plain language instead of inventing a code.",
    ];

  const standardsContext = isMath
    ? buildMathStandardsContext(`${selectedPriorityStandard}\n${data.sourceText}`)
    : (isSkills || isListening)
      ? buildSkillsStandardsContext(`${selectedPriorityStandard}\n${data.sourceText}`, isListening ? "ELA" : "Skills")
      : "";
  return [
    `Analyze this ${isKindergartenMath ? "Kindergarten Math" : "first grade curriculum"} lesson for a teacher-facing lesson library.`,
    "",
    `Subject selected by teacher: ${data.subject || "not provided"}`,
    `Unit/module selected by teacher: ${data.unitOrModule || "not provided"}`,
    `Lesson number selected by teacher: ${data.lessonNumber || "not provided"}`,
    `Lesson title selected by teacher: ${data.lessonTitle || "not provided"}`,
    `Priority standard selected by teacher before analysis: ${selectedPriorityStandard || "not provided"}`,
    "",
    "Return the exact structured fields requested by the schema.",
    selectedPriorityStandard
      ? "Use the teacher-selected priority standard as the anchor for this draft. The selected standard is trusted teacher input, not an invented standard. Keep the lesson content grounded in the source, but align the I Can statement, objective/focus, family summary, family questions, teacher notes, and standard notes to that selected priority standard. Do not replace it with a different standard just because another code appears first or more often in the source."
      : "If no priority standard was selected by the teacher, choose the best priority standard from the lesson source.",
    "Use full unit labels in unitOrModule: write Module 1 instead of M1, Mod 1, or module-1, and write Unit 1 instead of U1 when the source uses unit shorthand.",
    ...titleAndStandardGuidance,
    ...(selectedPriorityStandard
      ? ["Teacher-selected priority standard override: return the teacher-selected standard as the priority standard, and move other relevant source standards to supportingStandards when they apply."]
      : []),
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
    [KINDERGARTEN_MATH_SUBJECT]: "For Kindergarten Math, pull out family-friendly vocabulary and the main strategies, representations, or models scholars use. Leave sounds and sight words empty.",
    other: "Use the source to choose the most useful family-facing vocabulary and learning strategies, leaving unrelated categories empty.",
  }[data.subject] || "Use the source to choose the most useful family-facing fields.";

  return [
    `Analyze this complete ${isKindergartenMathSubject(data.subject) ? "Kindergarten Math" : `first grade ${subjectLabel}`} unit or module for the View by Unit page.`,
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
  return CURRICULUM_LESSON_SUBJECTS.includes(subject) ? subject : "other";
}

function labelForCurriculumSubject(subject) {
  switch (subject) {
    case "skills":
      return "Skills";
    case "listening":
      return "Listening & Learning";
    case "math":
      return "Math";
    case KINDERGARTEN_MATH_SUBJECT:
      return "Kindergarten Math";
    default:
      return "First Grade";
  }
}

function setCurriculumRecommendationCorsHeaders(request, response) {
  const origin = asText(request.get && request.get("origin"));
  const isLocalhost = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin);
  if (CURRICULUM_RECOMMENDATION_ALLOWED_ORIGINS.has(origin) || isLocalhost) {
    response.set("Access-Control-Allow-Origin", origin);
  }
  response.set("Vary", "Origin");
  response.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.set("Access-Control-Allow-Headers", "Content-Type");
  response.set("Access-Control-Max-Age", "3600");
}

function getCurriculumRecommendationRequestData(request) {
  if (request.method === "GET") return request.query || {};
  if (!request.body) return {};
  if (typeof request.body === "string") {
    try {
      return JSON.parse(request.body);
    } catch (error) {
      return {};
    }
  }
  return request.body;
}

function normalizeCurriculumRecommendationNeeds(value) {
  const rawNeeds = Array.isArray(value)
    ? value
    : asText(value).split(/[,;\n]/);
  const seen = new Set();
  return rawNeeds
    .map(normalizeCurriculumRecommendationNeed)
    .filter((need) => {
      const key = need.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 24);
}

function normalizeCurriculumRecommendationNeed(value) {
  return asText(value)
    .replace(/[`"“”]/g, "")
    .replace(/[|_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function normalizeCurriculumRecommendationSubject(value) {
  const subject = normalizeCurriculumSubject(asText(value));
  if (subject === KINDERGARTEN_MATH_SUBJECT) return "math";
  return ["skills", "listening", "math"].includes(subject) ? subject : "";
}

function normalizeCurriculumRecommendationLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return 8;
  return Math.min(12, Math.max(1, Math.floor(limit)));
}

function curriculumRecommendationSubjectMatches(lessonSubject, requestedSubject) {
  const subject = normalizeCurriculumSubject(lessonSubject);
  if (!requestedSubject) return true;
  if (requestedSubject === "math") {
    return subject === "math" || subject === KINDERGARTEN_MATH_SUBJECT;
  }
  return subject === requestedSubject;
}

function labelForCurriculumRecommendationSubject(subject) {
  const normalized = normalizeCurriculumSubject(subject);
  if (normalized === KINDERGARTEN_MATH_SUBJECT) return "Math";
  return labelForCurriculumSubject(normalized);
}

function scoreCurriculumRecommendationLesson(lesson, needs, requestedSubject) {
  if (!curriculumRecommendationSubjectMatches(lesson.subject, requestedSubject)) {
    return { score: 0, matchedNeeds: [], matchDetails: [] };
  }

  const directSkillText = normalizeCurriculumRecommendationSearchText([
    lesson.vocabulary,
    lesson.soundSpellings,
  ]);
  const standardText = normalizeCurriculumRecommendationSearchText([
    lesson.priorityStandard,
    lesson.priorityStandardCode,
    lesson.priorityStandardNumber,
    lesson.priorityStandardWording,
    lesson.supportingStandards,
    lesson.standardNotes,
  ]);
  const lessonIdentityText = normalizeCurriculumRecommendationSearchText([
    lesson.subject,
    lesson.unitOrModule,
    lesson.lessonNumber,
    lesson.lessonTitle,
    lesson.officialLessonTitle,
  ]);
  const learningText = normalizeCurriculumRecommendationSearchText([
    lesson.iCanStatement,
    lesson.objective,
    lesson.parentSummary,
    lesson.teacherNotes,
    lesson.familyQuestions,
  ]);
  const sourceText = normalizeCurriculumRecommendationSearchText(asText(lesson.sourceText).slice(0, 12000));
  const matchedNeeds = [];
  const matchDetails = [];
  let score = 0;

  needs.forEach((need) => {
    const variants = getCurriculumRecommendationNeedVariants(need);
    let bestMatch = { score: 0, matchType: "", reason: "" };
    variants.forEach((variant) => {
      if (!variant) return;
      if (curriculumRecommendationSearchIncludes(directSkillText, variant) && bestMatch.score < 44) {
        bestMatch = {
          score: 44,
          matchType: "direct",
          reason: `The need "${need}" appears in the lesson's vocabulary or sound/spelling targets.`,
        };
      }
      if (curriculumRecommendationSearchIncludes(standardText, variant) && bestMatch.score < 36) {
        bestMatch = {
          score: 36,
          matchType: "standard",
          reason: `The need "${need}" matches the lesson's standard, prerequisite standard, or standard notes.`,
        };
      }
      if (curriculumRecommendationSearchIncludes(lessonIdentityText, variant) && bestMatch.score < 24) {
        bestMatch = {
          score: 24,
          matchType: "lesson",
          reason: `The need "${need}" appears in the lesson title, number, unit, or module identity.`,
        };
      }
      if (curriculumRecommendationSearchIncludes(learningText, variant) && bestMatch.score < 18) {
        bestMatch = {
          score: 18,
          matchType: "related",
          reason: `The need "${need}" appears in the lesson objective, I Can statement, family summary, or teacher notes.`,
        };
      }
      if (curriculumRecommendationSearchIncludes(sourceText, variant) && bestMatch.score < 8) {
        bestMatch = {
          score: 8,
          matchType: "source",
          reason: `The need "${need}" appears in the saved lesson source text.`,
        };
      }
    });
    if (bestMatch.score > 0) {
      matchedNeeds.push(need);
      matchDetails.push({
        need,
        matchType: bestMatch.matchType,
        reason: bestMatch.reason,
      });
      score += bestMatch.score;
    }
  });

  if (!matchedNeeds.length) return { score: 0, matchedNeeds: [], matchDetails: [] };

  const subject = normalizeCurriculumSubject(lesson.subject);
  if (requestedSubject && curriculumRecommendationSubjectMatches(subject, requestedSubject)) score += 12;
  if (lesson.priorityStandard || lesson.priorityStandardWording) score += 3;
  if (lesson.iCanStatement || lesson.objective) score += 3;

  return {
    score,
    matchDetails: matchDetails.slice(0, 8),
    matchedNeeds: matchedNeeds.slice(0, 8),
  };
}

function getCurriculumRecommendationNeedVariants(need) {
  const normalized = normalizeCurriculumRecommendationSearchText(need);
  const variants = new Set([normalized]);

  normalized
    .split(/\s+-\s+|\s+:\s+|\s+\/\s+/)
    .map((part) => part.trim())
    .filter((part) => part && !isGenericCurriculumRecommendationTerm(part))
    .forEach((part) => variants.add(part));

  const skillMatches = normalized.match(/\b(?:sh|ch|th|wh|ph|ng|ck)\b|\bshort vowel [a-z]\b|\b[a-z]\b|\bsegment\w*\b|\bblend\w*\b|\baddition\b|\bsubtraction\b|\bwithin 5\b|\bretell\w*\b|\bkey details?\b|\bcentral message\b|\bfeelings?\b|\bsenses?\b/gi) || [];
  skillMatches
    .map(normalizeCurriculumRecommendationSearchText)
    .filter((part) => part && !isGenericCurriculumRecommendationTerm(part))
    .forEach((part) => variants.add(part));

  return Array.from(variants)
    .map((variant) => variant.trim())
    .filter((variant) => variant.length >= 1 && !isGenericCurriculumRecommendationTerm(variant))
    .slice(0, 12);
}

function isGenericCurriculumRecommendationTerm(value) {
  return [
    "question",
    "questions",
    "needs",
    "practice",
    "review",
    "needs review",
    "assessment",
    "game",
    "lesson",
    "level",
    "unit",
    "module",
  ].includes(value);
}

function normalizeCurriculumRecommendationSearchText(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeCurriculumRecommendationSearchText).filter(Boolean).join(" ");
  }
  if (value && typeof value === "object") {
    return normalizeCurriculumRecommendationSearchText(Object.values(value));
  }
  return asText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function curriculumRecommendationSearchIncludes(searchText, term) {
  const value = asText(term);
  if (!value) return false;
  if (/^[a-z]{1,2}$/i.test(value)) {
    return new RegExp(`(^|\\s)${escapeRegExp(value)}($|\\s)`, "i").test(searchText);
  }
  return searchText.includes(value);
}

function buildCurriculumRecommendationPayload(id, lesson, match) {
  const subject = normalizeCurriculumSubject(lesson.subject);
  const lessonNumber = asText(lesson.lessonNumber);
  const unitOrModule = normalizeCurriculumUnitOrModule(lesson.unitOrModule);
  const lessonTitle = asText(lesson.lessonTitle || lesson.officialLessonTitle || lesson.title)
    || [unitOrModule, formatCurriculumRecommendationLessonNumber(lessonNumber)].filter(Boolean).join(" - ")
    || "Saved curriculum lesson";
  const priorityStandard = asText(lesson.priorityStandard)
    || [lesson.priorityStandardCode || lesson.priorityStandardNumber, lesson.priorityStandardWording].map(asText).filter(Boolean).join(" - ");
  const matchedNeeds = match.matchedNeeds || [];
  return {
    id,
    subject: subject === KINDERGARTEN_MATH_SUBJECT ? "math" : subject,
    subjectLabel: labelForCurriculumRecommendationSubject(subject),
    unitOrModule,
    lessonNumber,
    lessonTitle,
    priorityStandard,
    iCanStatement: asText(lesson.iCanStatement),
    objective: asText(lesson.objective),
    parentSummary: asText(lesson.parentSummary),
    matchedNeeds,
    matchDetails: match.matchDetails || [],
    score: match.score,
    reason: matchedNeeds.length
      ? `Matches ${matchedNeeds.slice(0, 3).join(", ")}.`
      : "Matches the selected class need.",
    url: `${HUB_PUBLIC_URL}?teacherTool=curriculum&lessonId=${encodeURIComponent(id)}`,
  };
}

function formatCurriculumRecommendationLessonNumber(value) {
  const text = asText(value).replace(/^lesson\s*#?\s*/i, "");
  return text ? `Lesson ${text}` : "";
}

function getLessonNumberValue(value) {
  const match = asText(value).match(/\d+/);
  return match ? Number(match[0]) : 9999;
}

function escapeRegExp(value) {
  return asText(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const normalizedSubject = normalizeCurriculumSubject(normalized.subject);
  normalized.subject = fallbackSubject === KINDERGARTEN_MATH_SUBJECT && normalizedSubject === "math"
    ? KINDERGARTEN_MATH_SUBJECT
    : (normalizedSubject === "other" && fallbackSubject !== "other" ? fallbackSubject : normalizedSubject);

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

function normalizeMathStandardFields(analysis, sourceText, options = {}) {
  const selectedPriorityStandard = asText(options.selectedPriorityStandard);
  const referenceText = [selectedPriorityStandard, sourceText].filter(Boolean).join("\n");
  const { codes, standardsByCode } = getMathReferenceMatches(referenceText);
  const contentCodes = codes.filter((code) => !isMathematicalPracticeCode(code));
  const practiceCodes = codes.filter(isMathematicalPracticeCode);
  const selectedCodes = extractMathStandardCodes(selectedPriorityStandard)
    .filter((code) => !isMathematicalPracticeCode(code));
  const modelCodes = extractMathStandardCodes([
    analysis.priorityStandardCode,
    analysis.priorityStandardNumber,
    analysis.priorityStandard,
  ].filter(Boolean).join(" "));
  const selectedPriorityCode = selectedCodes.find((code) => contentCodes.includes(code));
  const modelPriorityCode = modelCodes.find((code) => contentCodes.includes(code));
  const priorityCode = selectedPriorityCode || modelPriorityCode || contentCodes[0] || "";
  const unavailableWording = "Official wording unavailable in the standards reference.";
  const getWording = (code) => {
    const standard = standardsByCode.get(code);
    return standard ? standard.officialWording : unavailableWording;
  };
  const display = (code) => `${code} - ${getWording(code)}`;
  const supportingCodes = contentCodes.filter((code) => code !== priorityCode);

  if (selectedPriorityStandard && !selectedCodes.length) {
    return {
      priorityStandardCode: "",
      priorityStandardNumber: "",
      priorityStandardWording: "",
      priorityStandard: normalizeScholarLanguage(selectedPriorityStandard),
      supportingStandards: contentCodes.map(display),
      mathematicalPractices: practiceCodes.map(display),
      standardNotes: normalizeScholarLanguage(analysis.standardNotes),
    };
  }

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

function normalizeSkillsStandardFields(analysis, sourceText, options = {}) {
  const selectedPriorityStandard = asText(options.selectedPriorityStandard);
  const referenceText = [selectedPriorityStandard, sourceText].filter(Boolean).join("\n");
  const { codes, standardsByCode } = getSkillsReferenceMatches(referenceText);
  const selectedCodes = extractSkillsStandardCodes(selectedPriorityStandard)
    .map((code) => normalizeSkillsStandardCode(code, standardsByCode));
  const modelCodes = extractSkillsStandardCodes([
    analysis.priorityStandardCode,
    analysis.priorityStandardNumber,
    analysis.priorityStandard,
  ].filter(Boolean).join(" ")).map((code) => normalizeSkillsStandardCode(code, standardsByCode));
  const selectedPriorityCodes = uniqueSkillsStandardCodes(selectedCodes)
    .map((code) => codes.find((sourceCode) => sourceCode.toUpperCase() === code.toUpperCase()) || "")
    .filter(Boolean)
    .slice(0, 2);
  const priorityCodes = selectedPriorityCodes.length ? selectedPriorityCodes : selectSkillsPriorityCodes(modelCodes, codes);
  if (!priorityCodes.length) {
    const fallbackPriority = normalizeScholarLanguage(selectedPriorityStandard || (options.preservePlainFallback ? analysis.priorityStandard : ""));
    return {
      priorityStandardCode: "",
      priorityStandardNumber: "",
      priorityStandardWording: options.preservePlainFallback ? normalizeScholarLanguage(analysis.priorityStandardWording) : "",
      priorityStandard: fallbackPriority,
      supportingStandards: options.preservePlainFallback ? normalizeScholarLanguageArray(analysis.supportingStandards) : [],
      mathematicalPractices: [],
      standardNotes: options.preservePlainFallback ? normalizeScholarLanguage(analysis.standardNotes) : "",
    };
  }
  const unavailableWording = "Official wording unavailable in the standards reference.";
  const getWording = (code) => {
    const standard = standardsByCode.get(asText(code).toUpperCase());
    return standard ? standard.officialWording : unavailableWording;
  };
  const display = (code) => `${code} - ${getWording(code)}`;

  if (selectedPriorityStandard && !selectedCodes.length) {
    return {
      priorityStandardCode: "",
      priorityStandardNumber: "",
      priorityStandardWording: "",
      priorityStandard: normalizeScholarLanguage(selectedPriorityStandard),
      supportingStandards: codes.map(display),
      mathematicalPractices: [],
      standardNotes: options.preservePlainFallback ? normalizeScholarLanguage(analysis.standardNotes) : "",
    };
  }

  const priorityKeys = new Set(priorityCodes.map((code) => code.toUpperCase()));
  const supportingCodes = codes.filter((code) => !priorityKeys.has(code.toUpperCase()));

  return {
    priorityStandardCode: priorityCodes.join(", "),
    priorityStandardNumber: priorityCodes.join(", "),
    priorityStandardWording: priorityCodes.map(getWording).join("\n"),
    priorityStandard: priorityCodes.map(display).join("\n"),
    supportingStandards: supportingCodes.map(display),
    mathematicalPractices: [],
    standardNotes: normalizeScholarLanguage(analysis.standardNotes),
  };
}

function normalizeCurriculumAnalysis(analysis, sourceText = "", options = {}) {
  const subject = normalizeCurriculumSubject(analysis.subject);
  const isMath = isMathCurriculumSubject(subject);
  const isSkills = subject === "skills";
  const isListening = subject === "listening";
  const standardFields = isMath
    ? normalizeMathStandardFields(analysis, sourceText, options)
    : (isSkills || isListening)
      ? normalizeSkillsStandardFields(analysis, sourceText, { ...options, preservePlainFallback: isListening })
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

function normalizeCurriculumPlanSection(value, index) {
  if (!value || typeof value !== "object") {
    const text = normalizeScholarLanguage(value);
    return text ? { key: `section-${index + 1}`, title: `Section ${index + 1}`, body: text } : null;
  }
  const title = normalizeScholarLanguage(value.title || value.heading || value.name) || `Section ${index + 1}`;
  const body = normalizeScholarLanguage(value.body || value.details || value.text || value.content);
  const key = asText(value.key || value.id || title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `section-${index + 1}`;
  if (!title && !body) return null;
  return { key, title, body };
}

function normalizeCurriculumPlanSections(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeCurriculumPlanSection)
    .filter(Boolean)
    .filter((section) => section.body || section.title)
    .slice(0, 24);
}

function normalizeCurriculumPlanPrincipalView(value) {
  const view = value && typeof value === "object" ? value : {};
  return {
    teacherDoing: normalizeScholarLanguage(view.teacherDoing),
    scholarsDoing: normalizeScholarLanguage(view.scholarsDoing),
    rotationBullets: normalizeScholarLanguageArray(view.rotationBullets).slice(0, 8),
    evidenceCollected: normalizeScholarLanguage(view.evidenceCollected),
    interventionOverview: normalizeScholarLanguage(view.interventionOverview),
  };
}

function getCurriculumPlanDisabledMatchers(toggleSettings) {
  const matchers = [];
  if (toggleSettings.teacherScript === false) matchers.push(/teacher script/i);
  if (toggleSettings.materials === false) matchers.push(/materials?/i);
  if (toggleSettings.pageNumbers === false) matchers.push(/pages?|page numbers?/i);
  if (toggleSettings.groupA === false) matchers.push(/group a/i);
  if (toggleSettings.groupB === false) matchers.push(/group b/i);
  if (toggleSettings.groupC === false) matchers.push(/group c/i);
  if (toggleSettings.handwriting === false) matchers.push(/handwriting/i);
  if (toggleSettings.reading === false) matchers.push(/\breading|decodable|book[-\s]?bag/i);
  if (toggleSettings.writing === false) matchers.push(/\bwriting|application/i);
  if (toggleSettings.learningGames === false) matchers.push(/learning games?|data check/i);
  if (toggleSettings.guidedWork === false) matchers.push(/guided work/i);
  if (toggleSettings.independentEvidence === false) matchers.push(/independent evidence|formative data/i);
  if (toggleSettings.intervention === false) matchers.push(/intervention|ufli/i);
  if (toggleSettings.extensions === false) matchers.push(/extension/i);
  return matchers;
}

function filterCurriculumPlanSectionsByToggles(sections, toggleSettings) {
  const matchers = getCurriculumPlanDisabledMatchers(toggleSettings);
  if (!matchers.length) return sections;
  return sections.filter((section) => {
    if (/^rotation-\d+$/i.test(section.key)) return true;
    const label = `${section.key} ${section.title}`;
    return !matchers.some((matcher) => matcher.test(label));
  });
}

function getCurriculumPlanRotationNumber(section) {
  const text = `${section && section.key || ""} ${section && section.title || ""}`;
  const match = text.match(/\brotation\s*([0-9]+)/i) || text.match(/\brotation-([0-9]+)/i);
  return match ? Number(match[1]) : 0;
}

function enforceCurriculumPlanChronology(sections, subject) {
  if (!["skills", "math"].includes(subject)) return sections;
  const maxRotation = subject === "skills" ? 3 : 5;
  const standaloneDetailPattern = subject === "skills"
    ? /^(teacher script|materials?|page numbers?|group [abc] tasks?|handwriting|reading|writing|learning games?(?: \/ data check)?|data check|guided work|independent evidence|extensions?)$/i
    : /^(teacher script|materials?|page numbers?|group [abc] tasks?|handwriting|reading|writing|learning games?(?: \/ data check)?|data check|guided work|independent evidence|intervention work|extensions?)$/i;
  const rotations = [];
  const readingInterventionSections = [];
  const otherSections = [];
  sections.forEach((section) => {
    const rotationNumber = getCurriculumPlanRotationNumber(section);
    if (rotationNumber) {
      if (rotationNumber <= maxRotation) rotations.push({ ...section, rotationNumber });
      return;
    }
    if (subject === "skills" && /\b(?:reading\s+)?intervention\b|\bufli\b/i.test(asText(section.title))) {
      readingInterventionSections.push({
        ...section,
        key: section.key || "reading-intervention",
        title: /11:30|12:00/.test(section.title) ? section.title : "Reading Intervention (11:30-12:00)",
      });
      return;
    }
    if (!standaloneDetailPattern.test(asText(section.title))) {
      otherSections.push(section);
    }
  });
  rotations.sort((a, b) => a.rotationNumber - b.rotationNumber);
  return [
    ...rotations.map(({ rotationNumber, ...section }) => section),
    ...readingInterventionSections,
    ...otherSections,
  ];
}

function normalizeCurriculumPlanMissingInformation(value) {
  return normalizeScholarLanguageArray(value).filter((item) => {
    const text = item.toLowerCase();
    if (!text) return false;
    if (/\b(if available|as available|when available|use assigned work|complete the worksheet|as needed)\b/.test(text)) return false;
    if (/\bsource\b.*\b(does not provide|doesn't provide|does not include|doesn't include|lacks|missing|not supplied)\b/.test(text)) return false;
    if (/\b(not provided|not supplied|not included|not in the source|not in source)\b/.test(text)) return false;
    if (/\b(teacher must supply|must supply|must provide|do not assign|cannot assign|invented response)\b/.test(text)) return false;
    if (/\b(recording page|data[-\s]?check form|intervention work|independent work|handwriting practice|writing\/application|book[-\s]?bag|free[-\s]?choice reading|lesson[-\s]?aligned extension)\b/.test(text)) return false;
    return true;
  }).slice(0, 4);
}

function normalizeCurriculumPlanAnalysis(rawAnalysis, fallback = {}) {
  if (!rawAnalysis || typeof rawAnalysis !== "object" || Array.isArray(rawAnalysis)) {
    throw new Error("The response root must be a JSON object.");
  }
  const subject = normalizeCurriculumPlanSubject(rawAnalysis.subject || fallback.subject);
  const toggleSettings = normalizeCurriculumPlanToggleSettings(fallback.toggleSettings);
  const sections = enforceCurriculumPlanChronology(
    filterCurriculumPlanSectionsByToggles(
      normalizeCurriculumPlanSections(rawAnalysis.teacherSubView || rawAnalysis.sections),
      toggleSettings
    ),
    subject
  );
  const principalView = normalizeCurriculumPlanPrincipalView(rawAnalysis.principalView);
  const lessonTitle = normalizeScholarLanguage(rawAnalysis.lessonTitle || fallback.lessonTitle);
  const priorityStandard = normalizeScholarLanguage(rawAnalysis.priorityStandard || fallback.priorityStandard);
  const planTitle = normalizeScholarLanguage(rawAnalysis.planTitle)
    || lessonTitle
    || `${labelForCurriculumSubject(subject)} ${normalizeScholarLanguage(rawAnalysis.lessonNumber || fallback.lessonNumber || "Plan")}`;

  return {
    subject,
    unitOrModule: normalizeCurriculumUnitOrModule(rawAnalysis.unitOrModule || fallback.unitOrModule),
    lessonNumber: normalizeScholarLanguage(rawAnalysis.lessonNumber || fallback.lessonNumber),
    lessonTitle,
    planTitle,
    priorityStandard,
    iCanStatement: normalizeScholarLanguage(rawAnalysis.iCanStatement),
    teacherSubView: sections,
    principalView,
    missingInformation: normalizeCurriculumPlanMissingInformation(rawAnalysis.missingInformation),
    sourceConfidence: ["high", "medium", "low"].includes(rawAnalysis.sourceConfidence) ? rawAnalysis.sourceConfidence : "medium",
  };
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
