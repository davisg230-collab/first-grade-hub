(function () {
  "use strict";

  const DAVIS_ID = "davis";

  /*
    Easy configuration:
    These moods receive the private teacher check-in question.

    Okay and Tired currently receive supportive feedback,
    but do NOT automatically trigger the teacher question.
  */
  const DAVIS_TEACHER_PROMPT_MOODS = new Set([
    "worried",
    "sad",
    "mad"
  ]);

  const DAVIS_FEEDBACK = {
    great: {
      audio: "davisFeedbackGreat",
      text: "I'm glad you're feeling great this morning! Keep that good energy going and help make our classroom a great place to learn."
    },
    good: {
      audio: "davisFeedbackGood",
      text: "I'm glad you're feeling good this morning. You're ready to get started and have a strong day."
    },
    okay: {
      audio: "davisFeedbackOkay",
      text: "It's okay to feel just okay. Take a slow breath, get settled, and give yourself a little time to get ready for the day."
    },
    tired: {
      audio: "davisFeedbackTired",
      text: "I'm sorry you're feeling tired this morning. Try taking a big stretch and a few slow breaths. Take your morning work one step at a time."
    },
    worried: {
      audio: "davisFeedbackWorried",
      text: "I'm sorry you're feeling worried. You're here, you're safe, and we can take today one step at a time."
    },
    sad: {
      audio: "davisFeedbackSad",
      text: "I'm sorry you're feeling sad. You can say hi to a friend, ask for a fist bump, or talk with an adult you trust."
    },
    mad: {
      audio: "davisFeedbackMad",
      text: "It's okay to feel mad. Try three slow breaths, stretch your hands, and give your body a quiet moment to calm down."
    }
  };


  // ----------------------------------------------------------
  // PRESERVE CURRENT / LEGACY CHECK-IN
  // ----------------------------------------------------------

  const legacySelectScholarCheckInScholar =
    typeof window.selectScholarCheckInScholar === "function"
      ? window.selectScholarCheckInScholar
      : null;

  const legacyRenderScholarCheckInTodayView =
    typeof window.renderScholarCheckInTodayView === "function"
      ? window.renderScholarCheckInTodayView
      : null;

  const legacyRenderScholarCheckInHistoryView =
    typeof window.renderScholarCheckInHistoryView === "function"
      ? window.renderScholarCheckInHistoryView
      : null;


  // ----------------------------------------------------------
  // NEW AUDIO KEYS
  // ----------------------------------------------------------

  Object.assign(scholarCheckInAudioManifest, {
    davisBackpack:
      "/audio/check-in/davis-backpack.mp3?v=20260828",

    davisBreakfastQuestion:
      "/audio/check-in/davis-breakfast-question.mp3?v=20260901",

    davisLunchType:
      "/audio/check-in/davis-lunch-type.mp3?v=20260828",

    davisHomeLunch:
      "/audio/check-in/davis-home-lunch.mp3?v=20260828",

    davisSchoolLunch:
      "/audio/check-in/davis-school-lunch.mp3?v=20260828",

    davisFeedbackGreat:
      "/audio/check-in/davis-feedback-great.mp3?v=20260828",

    davisFeedbackGood:
      "/audio/check-in/davis-feedback-good.mp3?v=20260828",

    davisFeedbackOkay:
      "/audio/check-in/davis-feedback-okay.mp3?v=20260828",

    davisFeedbackTired:
      "/audio/check-in/davis-feedback-tired.mp3?v=20260828",

    davisFeedbackWorried:
      "/audio/check-in/davis-feedback-worried.mp3?v=20260828",

    davisFeedbackSad:
      "/audio/check-in/davis-feedback-sad.mp3?v=20260828",

    davisFeedbackMad:
      "/audio/check-in/davis-feedback-mad.mp3?v=20260828",

    davisFinalBreakfastAction:
      "/audio/check-in/davis-final-breakfast-action.mp3?v=20260901",

    davisFinalStoryAction:
      "/audio/check-in/davis-final-story-action.mp3?v=20260901",

    davisFinalReadyAction:
      "/audio/check-in/davis-final-ready-action.mp3?v=20260901",

    davisFinalMeetingAction:
      "/audio/check-in/davis-final-meeting-action.mp3?v=20260901",

    davisTimeFallback:
      "/audio/check-in/davis-time-fallback.mp3?v=20260828"
  });


  // ----------------------------------------------------------
  // SMALL HELPERS
  // ----------------------------------------------------------

  function isDavisMorningCheckIn() {
    return scholarCheckInState?.teacher?.id === DAVIS_ID;
  }

  function getContent() {
    return document.getElementById("scholarCheckInContent");
  }

  let davisCurrentGoogleSpeech = null;
  let davisCurrentAudioSequence = null;

  function clearDavisGoogleSpeechReplay() {
    davisCurrentGoogleSpeech = null;
  }

  function clearDavisAudioSequenceReplay() {
    davisCurrentAudioSequence = null;
  }

  function setDavisGoogleSpeechReplay(kind, data, selectors, content) {
    clearDavisAudioSequenceReplay();

    davisCurrentGoogleSpeech = {
      kind,
      data: {
        ...(data || {})
      },
      selectors: Array.isArray(selectors)
        ? [...selectors]
        : [],
      content
    };
  }

  function setDavisAudioSequenceReplay(audioItems, selectors, content) {
    clearDavisGoogleSpeechReplay();

    davisCurrentAudioSequence = {
      audioItems: Array.isArray(audioItems)
        ? [...audioItems]
        : [],
      selectors: Array.isArray(selectors)
        ? [...selectors]
        : [],
      content
    };
  }

  function replayDavisCurrentAudio() {
    if (
      davisCurrentAudioSequence &&
      davisCurrentAudioSequence.content &&
      davisCurrentAudioSequence.content.isConnected
    ) {
      davisPlayAudioSequence(
        davisCurrentAudioSequence.audioItems,
        davisCurrentAudioSequence.selectors,
        davisCurrentAudioSequence.content
      );

      return;
    }

    if (
      davisCurrentGoogleSpeech &&
      davisCurrentGoogleSpeech.content &&
      davisCurrentGoogleSpeech.content.isConnected
    ) {
      davisPlayGoogleCheckInSpeech(
        davisCurrentGoogleSpeech.kind,
        davisCurrentGoogleSpeech.data,
        davisCurrentGoogleSpeech.selectors,
        davisCurrentGoogleSpeech.content
      );

      return;
    }

    playScholarCheckInCurrentAudio();
  }

  function hearAgainButton() {
    return `
      <button
        type="button"
        class="check-in-small-button"
        data-davis-hear-again
      >
        🔊 Hear Again
      </button>
    `;
  }

  function bindHearAgain(content) {
    content
      ?.querySelector("[data-davis-hear-again]")
      ?.addEventListener("click", () => {
        replayDavisCurrentAudio();
      });
  }

  function autoSpeak(key) {
    clearDavisAudioSequenceReplay();
    clearDavisGoogleSpeechReplay();
    setScholarCheckInAudioKey(key);

    setTimeout(() => {
      playScholarCheckInAudio(key, {
        silentBlock: true
      });
    }, 40);
  }

  function resetDavisMorningState() {
    scholarCheckInState.backpackReady = null;
    scholarCheckInState.lunchType = null;
    scholarCheckInState.lunchDutyConfirmed = null;
    scholarCheckInState.davisCompletionInfo = null;
  }

  function getMorningTimeInfo(now = new Date()) {
    const cutoff = new Date(now);
    cutoff.setHours(9, 0, 0, 0);

    const beforeCutoff = now < cutoff;

    const minutesBefore900 = beforeCutoff
      ? Math.max(
          0,
          Math.ceil(
            (cutoff.getTime() - now.getTime()) / 60000
          )
        )
      : 0;

    return {
      now,
      beforeCutoff,
      minutesBefore900,
      displayTime: now.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit"
      })
    };
  }

  function getTimeFilename(now) {
    const hour = String(now.getHours()).padStart(2, "0");
    const minute = String(now.getMinutes()).padStart(2, "0");

    const total = (now.getHours() * 60) + now.getMinutes();

    if (
      total >= (7 * 60) &&
      total <= ((9 * 60) + 30)
    ) {
      return `/audio/check-in/davis-time-${hour}${minute}.mp3?v=20260828`;
    }

    return "/audio/check-in/davis-time-fallback.mp3?v=20260828";
  }

  function getTimeOnlyFilename(now) {
    const hour = String(now.getHours()).padStart(2, "0");
    const minute = String(now.getMinutes()).padStart(2, "0");

    const total = (now.getHours() * 60) + now.getMinutes();

    if (
      total >= (7 * 60) &&
      total <= ((9 * 60) + 30)
    ) {
      return `/audio/check-in/davis-time-only-${hour}${minute}.mp3?v=20260901`;
    }

    return "/audio/check-in/davis-time-only-fallback.mp3?v=20260901";
  }

  function getDavisAudioSource(audioItem) {
    if (!audioItem) return "";

    return (
      scholarCheckInAudioManifest?.[audioItem] ||
      String(audioItem)
    );
  }

  function getBackDestinationFromLunch() {
    return scholarCheckInState.lunchType === "home"
      ? renderDavisHomeLunchScreen
      : renderDavisSchoolLunchScreen;
  }


  // ----------------------------------------------------------
  // STEP 1 — SCHOLAR CHOOSES NAME
  // ----------------------------------------------------------

  window.selectScholarCheckInScholar = function (scholarId) {
    const teacher =
      scholarCheckInState.teacher ||
      scholarCheckInTeachers[0];

    if (
      !teacher ||
      teacher.id !== DAVIS_ID
    ) {
      if (legacySelectScholarCheckInScholar) {
        return legacySelectScholarCheckInScholar.call(
          window,
          scholarId
        );
      }

      return;
    }

    const scholar = getScholarCheckInRoster(teacher.id)
      .find(item => item.id === scholarId);

    if (!scholar) return;

    scholarCheckInState.scholar = scholar;
    scholarCheckInState.mood = null;
    scholarCheckInState.wantsTeacherCheckIn = null;
    scholarCheckInState.davisMoodConfirmed = false;

    resetDavisMorningState();

    scholarCheckInState.hasBreakfast = null;

    renderDavisBackpackScreen();
  };


  // ----------------------------------------------------------
  // STEP 2 — BACKPACK
  // ----------------------------------------------------------

  function renderDavisBackpackScreen() {
    renderDavisMorningChecklist();
  }

  function renderDavisLunchTypeScreen() {
    renderDavisMorningChecklist();
  }

  function renderDavisHomeLunchScreen() {
    renderDavisMorningChecklist();
  }

  function renderDavisSchoolLunchScreen() {
    renderDavisMorningChecklist();
  }

  let davisAudioGateId = 0;

  function davisStopCurrentCheckInAudio() {
    davisAudioGateId += 1;

    try {
      if (
        typeof scholarCheckInAudioPlayer !== "undefined" &&
        scholarCheckInAudioPlayer
      ) {
        scholarCheckInAudioPlayer.pause();
      }
    } catch (error) {
      console.warn(
        "Could not stop Davis check-in audio:",
        error
      );
    }
  }


  function davisPlayAndUnlock(
    audioKey,
    selectors,
    content
  ) {
    const source =
      getDavisAudioSource(audioKey);

    const getButtons = () =>
      selectors.flatMap(selector =>
        Array.from(
          content.querySelectorAll(selector)
        )
      );

    const lockButtons = () => {
      getButtons().forEach(button => {
        button.disabled = true;
        button.setAttribute(
          "data-davis-waiting-for-audio",
          "true"
        );
      });
    };

    const unlockButtons = () => {
      if (gateId !== davisAudioGateId) {
        return;
      }

      getButtons().forEach(button => {
        button.disabled = false;
        button.removeAttribute(
          "data-davis-waiting-for-audio"
        );
      });
    };

    lockButtons();

    setDavisAudioSequenceReplay(
      [audioKey],
      selectors,
      content
    );

    setScholarCheckInAudioKey(audioKey);
    davisStopCurrentCheckInAudio();

    const gateId =
      ++davisAudioGateId;

    if (!source) {
      setScholarCheckInStatus(
        "The sound did not start. Please tell your teacher.",
        "info"
      );
      return;
    }

    const player =
      new Audio(source);

    scholarCheckInAudioPlayer =
      player;

    player.preload =
      "auto";

    player.volume =
      1;

    player.addEventListener(
      "ended",
      unlockButtons,
      {
        once: true
      }
    );

    player.addEventListener(
      "error",
      () => {
        if (gateId !== davisAudioGateId) {
          return;
        }

        setScholarCheckInStatus(
          "The sound did not start. Tap Hear Again or tell your teacher.",
          "info"
        );
      },
      {
        once: true
      }
    );

    const playPromise =
      player.play();

    if (
      playPromise &&
      typeof playPromise.catch ===
        "function"
    ) {
      playPromise.catch(error => {
        if (gateId !== davisAudioGateId) {
          return;
        }

        console.warn(
          "Davis check-in audio could not play:",
          error
        );

        setScholarCheckInStatus(
          "Tap Hear Again to hear the direction.",
          "info"
        );
      });
    }
  }

  function davisPlayAudioSequence(
    audioItems,
    selectors,
    content
  ) {
    const sources =
      (Array.isArray(audioItems)
        ? audioItems
        : []
      )
        .map(getDavisAudioSource)
        .filter(Boolean);

    if (!sources.length) {
      return;
    }

    setDavisAudioSequenceReplay(
      audioItems,
      selectors,
      content
    );

    const getButtons = () =>
      selectors.flatMap(selector =>
        Array.from(
          content.querySelectorAll(selector)
        )
      );

    const lockButtons = () => {
      getButtons().forEach(button => {
        button.disabled = true;
        button.setAttribute(
          "data-davis-waiting-for-audio",
          "true"
        );
      });
    };

    lockButtons();
    davisStopCurrentCheckInAudio();

    const gateId =
      ++davisAudioGateId;

    const unlockButtons = () => {
      if (gateId !== davisAudioGateId) {
        return;
      }

      getButtons().forEach(button => {
        button.disabled = false;
        button.removeAttribute(
          "data-davis-waiting-for-audio"
        );
      });
    };

    let index = 0;

    const playNext = () => {
      if (gateId !== davisAudioGateId) {
        return;
      }

      if (index >= sources.length) {
        unlockButtons();
        return;
      }

      const player =
        new Audio(sources[index]);

      scholarCheckInAudioPlayer =
        player;

      player.preload =
        "auto";

      player.volume =
        1;

      player.addEventListener(
        "ended",
        () => {
          index += 1;
          playNext();
        },
        {
          once: true
        }
      );

      player.addEventListener(
        "error",
        () => {
          console.warn(
            "Davis check-in audio file could not play:",
            sources[index]
          );

          setScholarCheckInStatus(
            "The sound did not start. Tap Hear Again or tell your teacher.",
            "info"
          );
        },
        {
          once: true
        }
      );

      const playPromise =
        player.play();

      if (
        playPromise &&
        typeof playPromise.catch ===
          "function"
      ) {
        playPromise.catch(error => {
          console.warn(
            "Davis check-in audio sequence could not play:",
            error
          );

          setScholarCheckInStatus(
            "Tap Hear Again to hear the direction.",
            "info"
          );
        });
      }
    };

    playNext();
  }

  async function getDavisWeeklyStoryForCheckIn() {
    const directValues = [
      window.currentWeeklyStory,
      window.weeklyStory,
      window.weeklyStoryPrompt,
      window.currentWeeklyStoryPrompt
    ];

    for (const value of directValues) {
      if (
        typeof value === "string" &&
        value.trim().length > 5
      ) {
        return value.trim();
      }

      if (
        value &&
        typeof value === "object"
      ) {
        const text =
          value.prompt ||
          value.story ||
          value.text ||
          value.content;

        if (
          typeof text === "string" &&
          text.trim().length > 5
        ) {
          return text.trim();
        }
      }
    }

    try {
      if (
        typeof db !== "undefined" &&
        db
      ) {
        const snapshot =
          await db
            .collection("classData")
            .doc("current")
            .get();

        const data =
          snapshot.exists
            ? snapshot.data() || {}
            : {};

        const possibleFields = [
          data.weeklyStory,
          data.weekly_story,
          data.weeklyStoryPrompt,
          data.weekly_story_prompt,
          data.currentWeeklyStory,
          data.current_weekly_story
        ];

        for (const value of possibleFields) {
          if (
            typeof value === "string" &&
            value.trim().length > 5
          ) {
            return value.trim();
          }
        }
      }
    } catch (error) {
      console.warn(
        "Weekly Story lookup failed:",
        error
      );
    }

    return "";
  }

  const davisGoogleSpeechCache =
    new Map();


  async function davisPlayGoogleCheckInSpeech(
    kind,
    data,
    selectors,
    content
  ) {
    setDavisGoogleSpeechReplay(
      kind,
      data,
      selectors,
      content
    );

    const gateId =
      ++davisAudioGateId;

    const buttons =
      selectors.flatMap(selector =>
        Array.from(
          content.querySelectorAll(
            selector
          )
        )
      );

    const lock = () => {
      buttons.forEach(button => {
        button.disabled = true;
      });
    };

    const unlock = () => {
      if (gateId !== davisAudioGateId) {
        return;
      }

      buttons.forEach(button => {
        button.disabled = false;
      });
    };


    lock();

    davisStopCurrentCheckInAudio();

    /*
     * davisStopCurrentCheckInAudio increments
     * the gate ID, so establish the active gate
     * after stopping old audio.
     */
    const activeGateId =
      ++davisAudioGateId;


    const cacheKey =
      JSON.stringify({
        kind,
        ...(data || {})
      });


    try {

      let src =
        davisGoogleSpeechCache.get(
          cacheKey
        );


      if (!src) {

        const response =
          await fetch(
            "https://us-central1-first-grade-news-hub.cloudfunctions.net/synthesizeDavisCheckInSpeech",
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  data: {
                    kind,
                    ...(data || {})
                  }
                })
            }
          );


        const body =
          await response.json();


        if (!response.ok) {
          throw new Error(
            body?.error?.message ||
            "Google speech request failed."
          );
        }


        const result =
          body.result ||
          body.data ||
          {};


        if (!result.audioBase64) {
          throw new Error(
            "Google speech returned no audio."
          );
        }


        src =
          "data:audio/mpeg;base64," +
          result.audioBase64;


        davisGoogleSpeechCache.set(
          cacheKey,
          src
        );
      }


      if (
        activeGateId !== davisAudioGateId
      ) {
        return;
      }


      const player =
        new Audio(src);

      scholarCheckInAudioPlayer =
        player;

      player.preload =
        "auto";

      player.volume =
        1;


      const finish = () => {

        if (
          activeGateId !==
          davisAudioGateId
        ) {
          return;
        }

        buttons.forEach(button => {
          button.disabled = false;
        });
      };


      player.addEventListener(
        "ended",
        finish,
        {
          once: true
        }
      );


      player.addEventListener(
        "error",
        () => {
          if (
            activeGateId !==
            davisAudioGateId
          ) {
            return;
          }

          setScholarCheckInStatus(
            "The sound did not start. Tap Hear Again or tell your teacher.",
            "info"
          );
        },
        {
          once: true
        }
      );


      const playPromise =
        player.play();


      if (
        playPromise &&
        typeof playPromise.catch ===
          "function"
      ) {
        playPromise.catch(error => {
          console.warn(
            "Google check-in audio could not play:",
            error
          );

          setScholarCheckInStatus(
            "Tap Hear Again to hear the direction.",
            "info"
          );
        });
      }

    } catch (error) {

      console.warn(
        "Google check-in speech failed:",
        error
      );

      /*
       * IMPORTANT:
       * No ugly browser voice fallback.
       */
      setScholarCheckInStatus(
        "The sound did not start. Tap Hear Again or tell your teacher.",
        "info"
      );
    }
  }

  function renderDavisMorningChecklist() {
    davisStopCurrentCheckInAudio();
    clearScholarCheckInResetTimer();

    const scholar =
      scholarCheckInState.scholar;

    const backpackDone =
      scholarCheckInState.backpackReady === true;

    const breakfastAnswered =
      scholarCheckInState.hasBreakfast === true ||
      scholarCheckInState.hasBreakfast === false;

    const lunchType =
      scholarCheckInState.lunchType || "";

    const lunchDone =
      scholarCheckInState.lunchDutyConfirmed === true;

    setScholarCheckInHeader(
      "My Morning Checklist",
      scholar?.firstName || "Scholar"
    );

    setScholarCheckInStatus(
      !backpackDone
        ? "Start with your backpack."
        : !breakfastAnswered
          ? "Next, tell me about breakfast."
          : !lunchDone
            ? "Next, finish your lunch job."
            : "Your morning jobs are done!"
    );

    const content = getContent();
    if (!content) return;

    let lunchContent = "";

    if (
      backpackDone &&
      breakfastAnswered &&
      !lunchType
    ) {
      lunchContent = `
        <div class="davis-step-question">
          What kind of lunch do you have today?
        </div>

        <div class="davis-two-choice-grid">
          <button
            type="button"
            class="check-in-button davis-choice-card"
            data-davis-lunch="home"
          >
            <span class="davis-choice-icon">🥪</span>
            <span>Lunch From Home</span>
          </button>

          <button
            type="button"
            class="check-in-button davis-choice-card"
            data-davis-lunch="school"
          >
            <span class="davis-choice-icon">🏫</span>
            <span>School Lunch</span>
          </button>
        </div>
      `;
    }

    if (
      breakfastAnswered &&
      lunchType === "home" &&
      !lunchDone
    ) {
      lunchContent = `
        <div class="davis-selected-type">
          <strong>🥪 Lunch From Home</strong>

          <button
            type="button"
            class="check-in-small-button"
            data-davis-change-lunch
          >
            Change
          </button>
        </div>

        <div class="davis-direction-list">
          <div class="davis-direction-row">
            <span class="davis-direction-number">1</span>
            <span>
              Put your lunch box on the little shelf
              under your parking spot.
            </span>
          </div>

          <div class="davis-direction-row">
            <span class="davis-direction-number">2</span>
            <span>
              Put your water bottle or drink
              in the fridge.
            </span>
          </div>
        </div>

        <button
          type="button"
          class="check-in-button davis-wide-button"
          data-davis-lunch-ready
        >
          ✅ My Lunch Is Ready
        </button>
      `;
    }

    if (
      breakfastAnswered &&
      lunchType === "school" &&
      !lunchDone
    ) {
      lunchContent = `
        <div class="davis-selected-type">
          <strong>🏫 School Lunch</strong>

          <button
            type="button"
            class="check-in-small-button"
            data-davis-change-lunch
          >
            Change
          </button>
        </div>

        <div class="davis-direction-list">
          <div class="davis-direction-row">
            <span class="davis-direction-number">1</span>
            <span>
              Get your lunch lanyard from the hook
              next to your backpack.
            </span>
          </div>

          <div class="davis-direction-row">
            <span class="davis-direction-number">2</span>
            <span>
              Put it on the hook attached
              to your parking spot.
            </span>
          </div>
        </div>

        <button
          type="button"
          class="check-in-button davis-wide-button"
          data-davis-lunch-ready
        >
          ✅ My Lanyard Is Ready
        </button>
      `;
    }

    if (lunchDone) {
      lunchContent = `
        <div class="davis-complete-detail">
          ${
            lunchType === "home"
              ? "🥪 Lunch From Home"
              : "🏫 School Lunch"
          }
        </div>
      `;
    }

    content.innerHTML = `
      <style>
        .davis-checklist-wrap {
          width:min(760px,94%);
          margin:18px auto 8px;
          display:grid;
          gap:13px;
        }

        .davis-step-card {
          border-radius:22px;
          border:2px solid rgba(140,116,78,.12);
          padding:17px 20px;
          text-align:left;
          background:rgba(255,255,255,.58);
          box-shadow:0 7px 18px rgba(65,50,30,.05);
        }

        .davis-step-card.is-active {
          background:rgba(255,248,227,.96);
          border-color:rgba(223,176,71,.42);
          box-shadow:0 10px 24px rgba(65,50,30,.09);
        }

        .davis-step-card.is-complete {
          background:rgba(241,249,239,.88);
          padding-top:13px;
          padding-bottom:13px;
        }

        .davis-step-card.is-locked {
          opacity:.48;
          box-shadow:none;
        }

        .davis-step-header {
          display:flex;
          align-items:center;
          gap:12px;
        }

        .davis-step-circle {
          width:36px;
          height:36px;
          flex:0 0 36px;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          border-radius:50%;
          background:#819bad;
          color:white;
          font-weight:900;
        }

        .is-complete .davis-step-circle {
          background:#74a878;
        }

        .davis-step-title {
          font-size:1.25rem;
          font-weight:900;
          color:#172333;
        }

        .davis-step-subtitle {
          margin:6px 0 0 48px;
          color:#667078;
          font-weight:650;
        }

        .davis-step-body {
          margin:15px 0 0 48px;
        }

        .davis-step-question {
          font-size:1.4rem;
          font-weight:900;
          color:#172333;
          margin-bottom:14px;
        }

        .davis-two-choice-grid {
          display:grid;
          grid-template-columns:1fr 1fr;
          gap:12px;
        }

        .davis-choice-card {
          min-height:95px;
          display:flex !important;
          flex-direction:column;
          align-items:center;
          justify-content:center;
          gap:7px;
          font-size:1.1rem !important;
        }

        .davis-choice-icon {
          font-size:2rem;
        }

        .davis-selected-type {
          display:flex;
          justify-content:space-between;
          align-items:center;
          flex-wrap:wrap;
          gap:10px;
          margin-bottom:12px;
        }

        .davis-direction-list {
          display:grid;
          gap:9px;
          margin-bottom:14px;
        }

        .davis-direction-row {
          display:grid;
          grid-template-columns:32px 1fr;
          gap:10px;
          align-items:center;
          padding:11px 13px;
          border-radius:14px;
          background:rgba(255,255,255,.72);
          font-weight:700;
        }

        .davis-direction-number {
          width:28px;
          height:28px;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          border-radius:50%;
          background:#819bad;
          color:white;
          font-weight:900;
        }

        .davis-wide-button {
          width:100%;
          min-height:70px;
          font-size:1.25rem !important;
        }

        .davis-complete-detail {
          margin-left:48px;
          color:#315d3a;
          font-weight:900;
        }

        @media(max-width:650px) {
          .davis-two-choice-grid {
            grid-template-columns:1fr;
          }

          .davis-step-body,
          .davis-step-subtitle,
          .davis-complete-detail {
            margin-left:0;
          }
        }
      </style>

      <div class="davis-checklist-wrap">

        <section
          class="davis-step-card ${
            backpackDone ? "is-complete" : "is-active"
          }"
        >
          <div class="davis-step-header">
            <span class="davis-step-circle">
              ${backpackDone ? "✓" : "1"}
            </span>

            <span class="davis-step-title">
              Backpack
            </span>
          </div>

          ${
            backpackDone
              ? `
                <div class="davis-step-subtitle">
                  Backpack is put away!
                </div>
              `
              : `
                <div class="davis-step-subtitle">
                  Is your backpack put away?
                </div>

                <div class="davis-step-body">
                  <button
                    type="button"
                    class="check-in-button davis-wide-button"
                    data-davis-backpack-ready
                  >
                    🎒 Yes — It's Away
                  </button>
                </div>
              `
          }
        </section>


        <section
          class="davis-step-card ${
            breakfastAnswered
              ? "is-complete"
              : backpackDone
                ? "is-active"
                : "is-locked"
          }"
        >
          <div class="davis-step-header">
            <span class="davis-step-circle">
              ${breakfastAnswered ? "✓" : "2"}
            </span>

            <span class="davis-step-title">
              Breakfast
            </span>
          </div>

          ${
            !backpackDone
              ? `
                <div class="davis-step-subtitle">
                  Finish your backpack job first.
                </div>
              `
              : breakfastAnswered
                ? `
                  <div class="davis-step-subtitle">
                    ${
                      scholarCheckInState.hasBreakfast
                        ? "🍳 You have breakfast today."
                        : "🙂 No breakfast today."
                    }
                  </div>
                `
                : `
                  <div class="davis-step-subtitle">
                    Do you have breakfast with you today?
                  </div>

                  <div class="davis-step-body">
                    <div class="davis-two-choice-grid">

                      <button
                        type="button"
                        class="check-in-button davis-choice-card"
                        data-davis-breakfast="yes"
                      >
                        <span class="davis-choice-icon">🍳</span>
                        <span>Yes, I Have Breakfast</span>
                      </button>

                      <button
                        type="button"
                        class="check-in-button davis-choice-card"
                        data-davis-breakfast="no"
                      >
                        <span class="davis-choice-icon">🙂</span>
                        <span>No Breakfast</span>
                      </button>

                    </div>
                  </div>
                `
          }
        </section>


        <section
          class="davis-step-card ${
            lunchDone
              ? "is-complete"
              : breakfastAnswered
                ? "is-active"
                : "is-locked"
          }"
        >
          <div class="davis-step-header">
            <span class="davis-step-circle">
              ${lunchDone ? "✓" : "3"}
            </span>

            <span class="davis-step-title">
              Lunch
            </span>
          </div>

          ${
            !breakfastAnswered
              ? `
                <div class="davis-step-subtitle">
                  Finish the breakfast question first.
                </div>
              `
              : `
                <div class="davis-step-body">
                  ${lunchContent}
                </div>
              `
          }
        </section>


        <section
          class="davis-step-card ${
            lunchDone ? "is-active" : "is-locked"
          }"
        >
          <div class="davis-step-header">
            <span class="davis-step-circle">4</span>

            <span class="davis-step-title">
              Check In
            </span>
          </div>

          ${
            lunchDone
              ? `
                <div class="davis-step-subtitle">
                  Tell me how you're feeling.
                </div>

                <div class="davis-step-body">
                  <button
                    type="button"
                    class="check-in-button davis-wide-button"
                    data-davis-checklist-next
                  >
                    😊 Tell Me How I Feel
                  </button>
                </div>
              `
              : `
                <div class="davis-step-subtitle">
                  Finish your lunch job first.
                </div>
              `
          }
        </section>

      </div>

      <div class="check-in-action-row">
        ${hearAgainButton()}

        <button
          type="button"
          class="check-in-small-button"
          data-davis-back-scholar
        >
          Back
        </button>
      </div>
    `;

    content
      .querySelector("[data-davis-backpack-ready]")
      ?.addEventListener("click", () => {
        scholarCheckInState.backpackReady = true;
        renderDavisMorningChecklist();
      });

    content
      .querySelectorAll("[data-davis-breakfast]")
      .forEach(button => {
        button.addEventListener("click", () => {
          scholarCheckInState.hasBreakfast =
            button.dataset.davisBreakfast === "yes";

          renderDavisMorningChecklist();
        });
      });

    content
      .querySelectorAll("[data-davis-lunch]")
      .forEach(button => {
        button.addEventListener("click", () => {
          scholarCheckInState.lunchType =
            button.dataset.davisLunch;

          scholarCheckInState.lunchDutyConfirmed =
            false;

          renderDavisMorningChecklist();
        });
      });

    content
      .querySelector("[data-davis-change-lunch]")
      ?.addEventListener("click", () => {
        scholarCheckInState.lunchType = null;
        scholarCheckInState.lunchDutyConfirmed = false;
        renderDavisMorningChecklist();
      });

    content
      .querySelector("[data-davis-lunch-ready]")
      ?.addEventListener("click", () => {
        scholarCheckInState.lunchDutyConfirmed = true;
        renderDavisMorningChecklist();
      });

    content
      .querySelector("[data-davis-checklist-next]")
      ?.addEventListener(
        "click",
        renderDavisMoodScreen
      );

    content
      .querySelector("[data-davis-back-scholar]")
      ?.addEventListener(
        "click",
        renderScholarCheckInScholarScreen
      );

    bindHearAgain(content);

    if (!backpackDone) {
      davisPlayAndUnlock(
        "davisBackpack",
        [
          "[data-davis-backpack-ready]"
        ],
        content
      );

      return;
    }

    if (!breakfastAnswered) {
      davisPlayAndUnlock(
        "davisBreakfastQuestion",
        [
          "[data-davis-breakfast]"
        ],
        content
      );

      return;
    }

    if (!lunchType) {
      davisPlayAndUnlock(
        "davisLunchType",
        [
          "[data-davis-lunch]"
        ],
        content
      );

      return;
    }

    if (!lunchDone) {
      davisPlayAndUnlock(
        lunchType === "home"
          ? "davisHomeLunch"
          : "davisSchoolLunch",
        [
          "[data-davis-lunch-ready]",
          "[data-davis-change-lunch]"
        ],
        content
      );
    }
  }

  function renderDavisMoodScreen() {
    davisStopCurrentCheckInAudio();
    clearScholarCheckInResetTimer();

    const scholar =
      scholarCheckInState.scholar;

    const content =
      getContent();

    if (!content) return;


    const moods =
      typeof scholarCheckInMoods !==
        "undefined"
        &&
      Array.isArray(
        scholarCheckInMoods
      )
        ? scholarCheckInMoods
        : [
            {
              id: "great",
              label: "Great",
              face: "😁"
            },
            {
              id: "good",
              label: "Good",
              face: "🙂"
            },
            {
              id: "okay",
              label: "Okay",
              face: "😐"
            },
            {
              id: "tired",
              label: "Tired",
              face: "😴"
            },
            {
              id: "worried",
              label: "Worried",
              face: "😟"
            },
            {
              id: "sad",
              label: "Sad",
              face: "😢"
            },
            {
              id: "mad",
              label: "Mad",
              face: "😠"
            }
          ];


    const supportMoodIds =
      new Set([
        "tired",
        "worried",
        "sad",
        "mad"
      ]);


    const feedbackKeyForMood =
      mood => {

        if (!mood) return "";

        return (
          "davisFeedback" +
          mood.id
            .charAt(0)
            .toUpperCase() +
          mood.id.slice(1)
        );
      };


    function getMoodStyles() {
      return `
        <style>
          .davis-mood-wrap {
            width:min(860px,94%);
            min-height:min(620px,calc(100vh - 230px));
            margin:18px auto 0;
            text-align:center;
            display:grid;
            align-content:center;
            gap:18px;
          }

          .davis-mood-grid {
            display:grid;
            grid-template-columns:
              repeat(
                auto-fit,
                minmax(155px,1fr)
              );
            gap:16px;
            margin-top:0;
          }

          .davis-mood-choice {
            min-height:150px;
            display:flex !important;
            flex-direction:column;
            justify-content:center;
            align-items:center;
            gap:10px;
            border-radius:24px !important;
            font-size:clamp(1.25rem,2.2vw,1.75rem) !important;
            font-weight:900 !important;
            line-height:1.12 !important;
          }

          .davis-mood-face {
            font-size:clamp(3.2rem,7vw,5rem);
            line-height:1;
          }

          .davis-mood-card {
            width:min(650px,100%);
            margin:0 auto;
            padding:clamp(28px,5vw,42px);
            border-radius:26px;
            background:
              rgba(255,248,227,.96);
            border:
              2px solid
              rgba(223,176,71,.35);
            box-shadow:0 12px 28px rgba(60,45,25,.08);
            text-align:center;
          }

          .davis-mood-big-face {
            font-size:clamp(4.5rem,10vw,7rem);
            line-height:1;
            margin-bottom:16px;
          }

          .davis-mood-big-title {
            font-size:clamp(2rem,4.4vw,3rem);
            line-height:1.1;
            font-weight:900;
            color:#172333;
          }

          .davis-mood-question {
            max-width:520px;
            margin:14px auto 0;
            font-size:clamp(1.25rem,2.3vw,1.65rem);
            line-height:1.35;
            font-weight:800;
            color:#59636c;
          }

          .davis-mood-buttons {
            display:flex;
            justify-content:center;
            align-items:center;
            flex-wrap:wrap;
            gap:14px;
            margin-top:24px;
          }

          .davis-mood-buttons
          .check-in-button {
            min-width:180px;
            min-height:72px;
            font-size:1.22rem !important;
          }

          .davis-feedback-heading {
            font-size:clamp(1.9rem,4vw,2.7rem);
            line-height:1.12;
            font-weight:900;
            color:#172333;
          }

          .davis-feedback-note {
            max-width:500px;
            margin:14px auto 0;
            color:#59636c;
            font-size:clamp(1.2rem,2.2vw,1.55rem);
            line-height:1.35;
            font-weight:750;
          }

          @media(max-width:650px) {
            .davis-mood-wrap {
              min-height:auto;
              width:min(100%,94%);
              margin-top:12px;
            }

            .davis-mood-grid {
              grid-template-columns:
                repeat(2,minmax(0,1fr));
              gap:12px;
            }

            .davis-mood-choice {
              min-height:132px;
            }

            .davis-mood-buttons {
              flex-direction:column;
            }

            .davis-mood-buttons
            .check-in-button {
              width:min(360px,100%);
            }
          }

          @media(max-width:420px) {
            .davis-mood-grid {
              grid-template-columns:1fr;
            }
          }
        </style>
      `;
    }


    function renderChoices() {
      davisStopCurrentCheckInAudio();

      setScholarCheckInHeader(
        "How Are You Feeling?",
        scholar?.firstName ||
          "Scholar"
      );

      setScholarCheckInStatus(
        "Choose the feeling that is closest to how you feel right now."
      );


      content.innerHTML = `
        ${getMoodStyles()}

        <div class="davis-mood-wrap">

          <div class="davis-mood-grid">

            ${moods.map(mood => `
              <button
                type="button"
                class="
                  check-in-button
                  davis-mood-choice
                "
                data-davis-feeling="${mood.id}"
              >
                <span
                  class="davis-mood-face"
                  aria-hidden="true"
                >
                  ${mood.face}
                </span>

                <span>
                  ${escapeHtml(mood.label)}
                </span>
              </button>
            `).join("")}

          </div>

          <div class="check-in-action-row">
            ${hearAgainButton()}

            <button
              type="button"
              class="check-in-small-button"
              data-davis-back-checklist
            >
              Back
            </button>
          </div>

        </div>
      `;


      content
        .querySelectorAll(
          "[data-davis-feeling]"
        )
        .forEach(button => {

          button.addEventListener(
            "click",
            () => {

              const id =
                button.dataset
                  .davisFeeling;

              const mood =
                moods.find(
                  item =>
                    item.id === id
                );

              if (!mood) return;

              scholarCheckInState.mood =
                mood;

              scholarCheckInState
                .wantsTeacherCheckIn =
                  null;

              renderConfirmation(
                mood
              );
            }
          );
        });


      content
        .querySelector(
          "[data-davis-back-checklist]"
        )
        ?.addEventListener(
          "click",
          renderDavisMorningChecklist
        );


      bindHearAgain(content);


      davisPlayAndUnlock(
        "chooseMood",
        [
          "[data-davis-feeling]"
        ],
        content
      );
    }


    function renderConfirmation(
      mood
    ) {
      davisStopCurrentCheckInAudio();

      setScholarCheckInHeader(
        "Is This Right?",
        scholar?.firstName ||
          "Scholar"
      );

      setScholarCheckInStatus(
        "Listen, then choose Yes or No."
      );


      content.innerHTML = `
        ${getMoodStyles()}

        <div class="davis-mood-wrap">

          <div class="davis-mood-card">

            <div class="davis-mood-big-face">
              ${mood.face}
            </div>

            <div class="davis-mood-big-title">
              ${escapeHtml(mood.label)}
            </div>

            <div class="davis-mood-question">
              Is this how you feel right now?
            </div>

            <div class="davis-mood-buttons">

              <button
                type="button"
                class="check-in-button"
                data-davis-mood-yes
              >
                ✓ Yes
              </button>

              <button
                type="button"
                class="check-in-button"
                data-davis-mood-no
              >
                No, Go Back
              </button>

            </div>

          </div>

          <div class="check-in-action-row">
            ${hearAgainButton()}
          </div>

        </div>
      `;


      content
        .querySelector(
          "[data-davis-mood-no]"
        )
        ?.addEventListener(
          "click",
          () => {
            scholarCheckInState.mood =
              null;

            renderChoices();
          }
        );


      content
        .querySelector(
          "[data-davis-mood-yes]"
        )
        ?.addEventListener(
          "click",
          () => {
            renderFeedback(
              mood
            );
          }
        );


      bindHearAgain(content);


      davisPlayAndUnlock(
        `confirm_${mood.id}`,
        [
          "[data-davis-mood-yes]",
          "[data-davis-mood-no]"
        ],
        content
      );
    }


    function renderFeedback(
      mood
    ) {
      davisStopCurrentCheckInAudio();

      setScholarCheckInHeader(
        "Thank You For Telling Me",
        scholar?.firstName ||
          "Scholar"
      );

      setScholarCheckInStatus(
        "Listen to your message."
      );


      content.innerHTML = `
        ${getMoodStyles()}

        <div class="davis-mood-wrap">

          <div class="davis-mood-card">

            <div class="davis-mood-big-face">
              ${mood.face}
            </div>

            <div class="davis-feedback-heading">
              I heard you.
            </div>

            <div class="davis-feedback-note">
              Thank you for checking in
              and telling me how you feel.
            </div>

            <div class="davis-mood-buttons">

              <button
                type="button"
                class="check-in-button"
                data-davis-feedback-next
              >
                Continue
              </button>

            </div>

          </div>

          <div class="check-in-action-row">
            ${hearAgainButton()}
          </div>

        </div>
      `;


      content
        .querySelector(
          "[data-davis-feedback-next]"
        )
        ?.addEventListener(
          "click",
          () => {

            if (
              supportMoodIds.has(
                mood.id
              )
            ) {
              renderTeacherSupport(
                mood
              );

              return;
            }


            scholarCheckInState
              .wantsTeacherCheckIn =
                false;

            renderDavisMorningTimeScreen();
          }
        );


      bindHearAgain(content);


      davisPlayAndUnlock(
        feedbackKeyForMood(mood),
        [
          "[data-davis-feedback-next]"
        ],
        content
      );
    }


    function renderTeacherSupport(
      mood
    ) {
      davisStopCurrentCheckInAudio();

      setScholarCheckInHeader(
        "Would You Like Help?",
        scholar?.firstName ||
          "Scholar"
      );

      setScholarCheckInStatus(
        "Listen, then choose Yes or No."
      );


      content.innerHTML = `
        ${getMoodStyles()}

        <div class="davis-mood-wrap">

          <div class="davis-mood-card">

            <div class="davis-mood-big-face">
              ${mood.face}
            </div>

            <div class="davis-mood-big-title">
              Would you like me
              to check in with you today?
            </div>

            <div class="davis-mood-buttons">

              <button
                type="button"
                class="check-in-button"
                data-davis-support="yes"
              >
                💙 Yes
              </button>

              <button
                type="button"
                class="check-in-button"
                data-davis-support="no"
              >
                No, I'm Okay
              </button>

            </div>

          </div>

          <div class="check-in-action-row">
            ${hearAgainButton()}
          </div>

        </div>
      `;


      content
        .querySelectorAll(
          "[data-davis-support]"
        )
        .forEach(button => {

          button.addEventListener(
            "click",
            () => {

              scholarCheckInState
                .wantsTeacherCheckIn =
                  button.dataset
                    .davisSupport ===
                    "yes";

              renderDavisMorningTimeScreen();
            }
          );
        });


      bindHearAgain(content);


      davisPlayAndUnlock(
        "teacherHelp",
        [
          "[data-davis-support]"
        ],
        content
      );
    }


    renderChoices();
  }

  async function renderDavisMorningTimeScreen() {
    davisStopCurrentCheckInAudio();
    clearScholarCheckInResetTimer();

    const scholar =
      scholarCheckInState.scholar;

    const info =
      getMorningTimeInfo();

    const now =
      info.now instanceof Date
        ? info.now
        : new Date();

    const stemStart =
      new Date(now);

    stemStart.setHours(
      9,
      5,
      0,
      0
    );

    const rawMinutesBefore905 =
      Math.ceil(
        (
          stemStart.getTime() -
          now.getTime()
        ) / 60000
      );

    const minutesBefore905 =
      Math.max(
        0,
        rawMinutesBefore905
      );

    const before900 =
      info.beforeCutoff === true;

    const hasBreakfast =
      scholarCheckInState.hasBreakfast === true;

    /*
     * We are using 9:00 as the latest time
     * to BEGIN Weekly Story.
     *
     * Once it reaches 9:00, Morning Meeting
     * has started and STEM is only 5 minutes away.
     */
    const enoughTimeForStory =
      before900 &&
      !hasBreakfast &&
      Number(info.minutesBefore900 || 0) >= 5;

    scholarCheckInState.davisCompletionInfo = {
      ...info,
      minutesBefore905,
      enoughTimeForStory
    };

    setScholarCheckInHeader(
      "What's Next?",
      scholar?.firstName || "Scholar"
    );

    setScholarCheckInStatus("");

    const content = getContent();
    if (!content) return;

    let actionHtml = "";
    let spokenDirection = "";


    if (!before900) {
      spokenDirection =
        `It is ${info.displayTime}. ` +
        `Morning Meeting has started. ` +
        `Go straight to the carpet and join your class.`;

      actionHtml = `
        <div class="davis-next-card">

          <div class="davis-next-time">
            ${escapeHtml(info.displayTime)}
          </div>

          <div class="davis-next-icon">
            🔔
          </div>

          <div class="davis-next-main">
            Go join Morning Meeting.
          </div>

          <div class="davis-next-sub">
            Go straight to the carpet
            and join your class.
          </div>

        </div>
      `;
    }


    if (
      before900 &&
      hasBreakfast
    ) {
      spokenDirection =
        `It is ${info.displayTime}. ` +
        `You have ${Number(info.minutesBefore900 || 0)} ` +
        `minutes until Morning Meeting. ` +
        `Go eat your breakfast. ` +
        `You have 5 minutes to eat. ` +
        `When you are finished, clean up and go to the carpet with your journal.`;

      actionHtml = `
        <div class="davis-next-card">

          <div class="davis-next-time">
            ${escapeHtml(info.displayTime)}
          </div>

          <div class="davis-next-small">
            ${Number(info.minutesBefore900 || 0)}
            ${
              Number(info.minutesBefore900 || 0) === 1
                ? "minute"
                : "minutes"
            }
            until Morning Meeting
          </div>

          <div class="davis-next-icon">
            🍳
          </div>

          <div class="davis-next-main">
            Go eat your breakfast.
          </div>

          <div class="davis-breakfast-pill">
            You have 5 minutes to eat.
          </div>

          <div class="davis-next-sub">
            When you're finished,
            clean up and go to the carpet
            with your journal.
          </div>

        </div>
      `;
    }


    if (
      before900 &&
      !hasBreakfast
    ) {
      spokenDirection =
        `It is ${info.displayTime}. ` +
        `You have ${Number(info.minutesBefore900 || 0)} ` +
        `minutes until Morning Meeting. ` +
        (
          enoughTimeForStory
            ? `Go to the carpet with your journal. ` +
              `Begin this week's story.`
            : `Go to the carpet with your journal ` +
              `and get ready for Morning Meeting.`
        );

      const weeklyStory =
        enoughTimeForStory
          ? await getDavisWeeklyStoryForCheckIn()
          : "";

      actionHtml = `
        <div class="davis-next-card">

          <div class="davis-next-time">
            ${escapeHtml(info.displayTime)}
          </div>

          <div class="davis-next-small">
            ${Number(info.minutesBefore900 || 0)}
            ${
              Number(info.minutesBefore900 || 0) === 1
                ? "minute"
                : "minutes"
            }
            until Morning Meeting
          </div>

          <div class="davis-next-icon">
            ${enoughTimeForStory ? "📓" : "🔔"}
          </div>

          <div class="davis-next-main">
            ${
              enoughTimeForStory
                ? "Go to the carpet with your journal."
                : "Get ready for Morning Meeting."
            }
          </div>

          ${
            enoughTimeForStory
              ? `
                <div class="davis-story-card">

                  <div class="davis-story-title">
                    ✏️ This Week's Story
                  </div>

                  <div class="davis-story-text">
                    ${
                      weeklyStory
                        ? escapeHtml(weeklyStory)
                        : "Begin this week's story from the classroom prompt."
                    }
                  </div>

                </div>
              `
              : `
                <div class="davis-next-sub">
                  Get ready for Morning Meeting.
                </div>
              `
          }

        </div>
      `;
    }


    content.innerHTML = `
      <style>
        .davis-next-wrap {
          width:min(720px,94%);
          margin:22px auto 0;
          text-align:center;
        }

        .davis-next-card {
          padding:25px 24px;
          border-radius:26px;
          background:rgba(255,248,227,.95);
          border:2px solid rgba(223,176,71,.35);
          box-shadow:0 12px 28px rgba(60,45,25,.08);
        }

        .davis-next-time {
          font-size:clamp(2.6rem,7vw,4.5rem);
          font-weight:900;
          line-height:1;
          color:#172333;
        }

        .davis-next-small {
          margin-top:9px;
          font-size:1.08rem;
          font-weight:800;
          color:#687078;
        }

        .davis-next-icon {
          margin:20px 0 10px;
          font-size:3.5rem;
          line-height:1;
        }

        .davis-next-main {
          font-size:clamp(1.7rem,4vw,2.4rem);
          line-height:1.15;
          font-weight:900;
          color:#172333;
        }

        .davis-next-sub {
          max-width:560px;
          margin:12px auto 0;
          font-size:1.12rem;
          line-height:1.4;
          font-weight:700;
          color:#59636c;
        }

        .davis-breakfast-pill {
          display:inline-block;
          margin-top:14px;
          padding:10px 18px;
          border-radius:999px;
          background:white;
          font-size:1.15rem;
          font-weight:900;
          color:#614f27;
        }

        .davis-story-card {
          max-width:590px;
          margin:22px auto 0;
          padding:18px 20px;
          border-radius:20px;
          background:white;
          border:2px solid rgba(126,153,172,.2);
        }

        .davis-story-title {
          margin-bottom:10px;
          font-size:1.25rem;
          font-weight:900;
          color:#627f94;
        }

        .davis-story-text {
          font-size:1.2rem;
          line-height:1.5;
          font-weight:750;
          color:#172333;
          white-space:pre-wrap;
        }

        .davis-final-button-row {
          width:100%;
          display:flex;
          justify-content:center;
          align-items:center;
          margin:20px auto 0;
        }

        #davisMorningFinishBtn {
          width:min(420px,88%);
          min-width:260px;
          margin:0 auto !important;
        }
      </style>

      <div class="davis-next-wrap">

        ${actionHtml}

        <div class="davis-final-button-row">
          <button
            id="davisMorningFinishBtn"
            type="button"
            class="
              check-in-button
              check-in-submit-button
            "
          >
            ✓ I'm Done
          </button>
        </div>

      </div>
    `;

    const finishButton =
      content.querySelector(
        "#davisMorningFinishBtn"
      );

    const finalActionAudio =
      !before900
        ? "davisFinalMeetingAction"
        : hasBreakfast
          ? "davisFinalBreakfastAction"
          : enoughTimeForStory
            ? "davisFinalStoryAction"
            : "davisFinalReadyAction";

    davisPlayAudioSequence(
      [
        getTimeOnlyFilename(info.now),
        finalActionAudio
      ],
      [
        "#davisMorningFinishBtn"
      ],
      content
    );

    finishButton
      ?.addEventListener(
        "click",
        () => {
          davisStopCurrentCheckInAudio();
          submitDavisMorningCheckIn();
        }
      );
  }

  async function submitDavisMorningCheckIn() {

  const teacher =
    scholarCheckInState.teacher;

  const scholar =
    scholarCheckInState.scholar;

  const mood =
    scholarCheckInState.mood;


  if (
    !db ||
    !teacher ||
    !scholar ||
    !mood
  ) {

    setScholarCheckInStatus(
      "Something is missing. Please tell Mr. Davis.",
      "error"
    );

    return;
  }


  const button =
    document.getElementById(
      "davisMorningFinishBtn"
    );


  if (button) {

    button.disabled =
      true;

    button.textContent =
      "Saving...";
  }


  try {

    // --------------------------------------------------------
    // MAKE SURE THE KIOSK HAS FIREBASE AUTH
    // --------------------------------------------------------

    await ensureScholarCheckInWriteAuth();


    const dateKey =
      getScholarCheckInTodayKey();


    const docId =
      String(dateKey)
      +
      "_"
      +
      String(teacher.id)
      +
      "_"
      +
      String(scholar.id);


    const docRef =
      db
        .collection(
          SCHOLAR_CHECK_IN_COLLECTION
        )
        .doc(
          docId
        );


    function safeString(value) {

      if (
        value === undefined ||
        value === null
      ) {

        return "";
      }

      return String(value);
    }


    const fallbackName =
      (
        safeString(
          scholar.firstName
        )
        +
        " "
        +
        safeString(
          scholar.lastName
        )
      ).trim();


    // ========================================================
    // STEP ONE — CORE CHECK-IN
    //
    // ONLY the proven original fields.
    //
    // If this succeeds, the scholar's mood IS RECORDED.
    // ========================================================

    const coreRecord = {

      scholarId:
        safeString(
          scholar.id
        ),

      scholarName:
        safeString(
          scholar.name ||
          fallbackName
        ),

      scholarFirstName:
        safeString(
          scholar.firstName
        ),

      scholarLastName:
        safeString(
          scholar.lastName
        ),

      teacherId:
        safeString(
          teacher.id
        ),

      teacherName:
        safeString(
          teacher.name ||
          "Mr. Davis"
        ),

      mood:
        safeString(
          mood.id
        ),

      moodLabel:
        safeString(
          mood.label
        ),

      wantsTeacherCheckIn:
        scholarCheckInState
          .wantsTeacherCheckIn === true,

      date:
        safeString(
          dateKey
        ),

      timestamp:
        firebase.firestore
          .FieldValue
          .serverTimestamp(),

      updatedAt:
        firebase.firestore
          .FieldValue
          .serverTimestamp(),

      source:
        "scholar-check-in-kiosk",

      version:
        1
    };


    await docRef.set(
      coreRecord,
      {
        merge:
          true
      }
    );


    console.log(
      "DAVIS_CORE_CHECKIN_SAVED",
      docId
    );


    // ========================================================
    // STEP TWO — DAVIS MORNING EXTRAS
    //
    // These are OPTIONAL.
    //
    // If Firestore dislikes anything here,
    // the core check-in above STILL EXISTS.
    // ========================================================

    try {

      const info =
        scholarCheckInState
          .davisCompletionInfo
        ||
        getMorningTimeInfo();


      const lunchType =
        scholarCheckInState.lunchType;


      const minutes =
        Number(
          info?.minutesBefore900
        );


      const safeMinutes =
        Number.isInteger(minutes)
          ? minutes
          : 0;


      const extras = {

        morningRoutineVersion:
          3,

        backpackReady:
          scholarCheckInState
            .backpackReady === true,

        lunchDutyConfirmed:
          scholarCheckInState
            .lunchDutyConfirmed === true,

        dutyConfirmations: {

          backpackAway:
            scholarCheckInState
              .backpackReady === true,

          homeLunchStored:
            lunchType === "home",

          schoolLunchLanyardReady:
            lunchType === "school"
        },

        checkInCompletionTime:
          safeString(
            info?.displayTime
          ),

        checkInCompletionIso:
          info?.now instanceof Date
            ? info.now.toISOString()
            : new Date().toISOString(),

        minutesAvailableBefore900:
        safeMinutes,

      completedBefore900:
        info?.beforeCutoff === true,

      hasBreakfast:
        scholarCheckInState.hasBreakfast === true,

      minutesAvailableBefore905:
        Number(
          scholarCheckInState
            .davisCompletionInfo
            ?.minutesBefore905 || 0
        ),

      hadTimeForWeeklyStory:
        scholarCheckInState
          .davisCompletionInfo
          ?.enoughTimeForStory === true
      };


      if (
        lunchType === "home" ||
        lunchType === "school"
      ) {

        extras.lunchType =
          lunchType;
      }


      await docRef.set(
        extras,
        {
          merge:
            true
        }
      );


      console.log(
        "DAVIS_EXTRA_CHECKIN_DATA_SAVED",
        docId
      );


    } catch (
      extraError
    ) {

      console.warn(
        "Core check-in SAVED; Davis optional fields failed:",
        extraError
      );
    }


    // ========================================================
    // CORE SAVE SUCCEEDED — CONTINUE
    // ========================================================

    renderScholarCheckInSuccessScreen();


  } catch (
    error
  ) {

    console.error(
      "DAVIS_CORE_CHECKIN_SAVE_FAILED",
      {
        code:
          error?.code,

        message:
          error?.message,

        name:
          error?.name,

        error:
          error
      }
    );


    const code =
      error?.code
        ? String(error.code)
        : "unknown";


    setScholarCheckInStatus(
      "Check-in could not save. Tell Mr. Davis. Error: "
      +
      code,
      "error"
    );


    if (button) {

      button.disabled =
        false;

      button.textContent =
        "✓ I'm Ready";
    }
  }
}


  // ----------------------------------------------------------
  // TEACHER DASHBOARD — ADD MORNING DETAILS
  // ----------------------------------------------------------

  function formatMorningRecord(record) {
    if (!record) {
      return "—";
    }

    const duty =
      record.dutyConfirmations &&
      typeof record.dutyConfirmations === "object"
        ? record.dutyConfirmations
        : {};

    const lunch =
      record.lunchType === "home"
        ? "Home lunch"
        : record.lunchType === "school"
          ? "School lunch"
          : duty.homeLunchStored === true
            ? "Home lunch"
            : duty.schoolLunchLanyardReady === true
              ? "School lunch"
              : "";

    const minutesBefore900 =
      record.minutesAvailableBefore900 === null ||
      record.minutesAvailableBefore900 === undefined ||
      record.minutesAvailableBefore900 === ""
        ? null
        : Number(record.minutesAvailableBefore900);

    const timing =
      record.completedBefore900 === true &&
      Number.isFinite(minutesBefore900)
        ? record.checkInCompletionTime
          ? `${record.checkInCompletionTime} (${minutesBefore900} min before 9:00)`
          : `${minutesBefore900} min before 9:00`
        : record.completedBefore900 === false
          ? record.checkInCompletionTime
            ? `${record.checkInCompletionTime} (after 9:00)`
            : "After 9:00"
          : record.checkInCompletionTime
            ? `Finished ${record.checkInCompletionTime}`
            : "";

    const breakfast =
      record.hasBreakfast === true
        ? "Yes"
        : record.hasBreakfast === false
          ? "No"
          : "";

    const stemValue =
      record.minutesAvailableBefore905;

    const stemMinutes =
      stemValue === null ||
      stemValue === undefined ||
      stemValue === ""
        ? null
        : Number(stemValue);

    const hasMorningDetails =
      breakfast ||
      lunch ||
      timing ||
      Number.isFinite(stemMinutes) ||
      record.hadTimeForWeeklyStory === true ||
      record.hadTimeForWeeklyStory === false;

    if (!hasMorningDetails) {
      return "—";
    }

    return `
      <div
        style="
          font-size:12px;
          line-height:1.5;
          white-space:nowrap;
        "
      >
        ${
          breakfast
            ? `
              <div>
                Breakfast: ${breakfast}
              </div>
            `
            : ""
        }

        ${
          lunch
            ? `
              <div>
                Lunch: ${escapeHtml(lunch)}
              </div>
            `
            : ""
        }

        ${
          timing
            ? `
              <div>
                Time: ${escapeHtml(timing)}
              </div>
            `
            : ""
        }

        ${
          Number.isFinite(stemMinutes)
            ? `
              <div>
                STEM: ${stemMinutes} min before 9:05
              </div>
            `
            : ""
        }

        ${
          record.hadTimeForWeeklyStory === true
            ? `
              <div>
                Weekly Story: Yes
              </div>
            `
            : record.hadTimeForWeeklyStory === false
              ? `
                <div>
                  Weekly Story: No
                </div>
              `
              : ""
        }
      </div>
    `;
  }

  window.formatDavisMorningRecordForReports =
    formatMorningRecord;

if (legacyRenderScholarCheckInTodayView) {
    window.renderScholarCheckInTodayView = function () {
      legacyRenderScholarCheckInTodayView.call(window);

      if (
        scholarCheckInDashboardState.teacherId !== DAVIS_ID
      ) {
        return;
      }

      const table =
        document.querySelector(
          "#scholarCheckInTodayList table"
        );

      if (!table) return;

      const headerRow =
        table.querySelector("thead tr");

      if (
        headerRow &&
        !headerRow.querySelector(
          "[data-davis-morning-column]"
        )
      ) {
        const th = document.createElement("th");
        th.textContent = "Morning";
        th.setAttribute(
          "data-davis-morning-column",
          "true"
        );
        headerRow.appendChild(th);
      }

      const roster =
        getScholarCheckInRoster(
          scholarCheckInDashboardState.teacherId
        );

      const recordMap =
        new Map(
          (scholarCheckInDashboardState.todayRecords || [])
            .map(record => [
              record.scholarId,
              record
            ])
        );

      const rows =
        Array.from(
          table.querySelectorAll("tbody tr")
        );

      rows.forEach((row, index) => {
        if (
          row.querySelector(
            "[data-davis-morning-cell]"
          )
        ) {
          return;
        }

        const scholar = roster[index];

        const record = scholar
          ? recordMap.get(scholar.id)
          : null;

        const td = document.createElement("td");
        td.setAttribute(
          "data-davis-morning-cell",
          "true"
        );

        td.innerHTML =
          formatMorningRecord(record);

        row.appendChild(td);
      });
    };
  }


  // ----------------------------------------------------------
  // SCHOLAR HISTORY — ADD MORNING DETAILS
  // ----------------------------------------------------------

  if (legacyRenderScholarCheckInHistoryView) {
    window.renderScholarCheckInHistoryView =
      function () {
        legacyRenderScholarCheckInHistoryView.call(
          window
        );

        if (
          scholarCheckInDashboardState.teacherId !==
          DAVIS_ID
        ) {
          return;
        }

        const panel =
          document.getElementById(
            "scholarCheckInHistoryPanel"
          );

        const table =
          panel?.querySelector("table");

        if (!table) return;

        const headerRow =
          table.querySelector("thead tr");

        if (
          headerRow &&
          !headerRow.querySelector(
            "[data-davis-history-morning-column]"
          )
        ) {
          const th =
            document.createElement("th");

          th.textContent = "Morning";

          th.setAttribute(
            "data-davis-history-morning-column",
            "true"
          );

          headerRow.appendChild(th);
        }

        let records = [];

        try {
          if (
            typeof getScholarHistoryFilteredRecords ===
            "function"
          ) {
            records =
              getScholarHistoryFilteredRecords();
          }
        } catch (error) {
          console.warn(
            "Morning history details could not determine filtered records:",
            error
          );
        }

        const rows =
          Array.from(
            table.querySelectorAll("tbody tr")
          );

        rows.forEach((row, index) => {
          if (
            row.querySelector(
              "[data-davis-history-morning-cell]"
            )
          ) {
            return;
          }

          const td =
            document.createElement("td");

          td.setAttribute(
            "data-davis-history-morning-cell",
            "true"
          );

          td.innerHTML =
            formatMorningRecord(
              records[index]
            );

          row.appendChild(td);
        });
      };
  }


  console.log(
    "✓ Mr. Davis Morning Check-In V2 loaded"
  );

})();

