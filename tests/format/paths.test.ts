import { moment } from "obsidian";
import { MEETING_START_FIELD } from "../../src/api/constants";
import {
  collisionCandidate,
  expandPattern,
  notePath,
  sanitizeTitle,
  subfolderFor,
  transcriptPath,
} from "../../src/format/paths";
import { DEFAULT_SETTINGS, type CirclebackSyncSettings } from "../../src/settings/types";
import { meetingLocal } from "../../src/util/time";

// 10:59:19 on 2026-10-20 in Chicago (CDT, UTC-5).
const START = "2026-10-20T15:59:19Z";
// 23:30 on 2026-10-27 in Chicago, but already the 28th in UTC.
const NEAR_MIDNIGHT = "2026-10-28T04:30:00Z";

const LONE_SURROGATE = /\p{Cs}/u;

function meetingAt(name: string | null, iso: string) {
  return { name, [MEETING_START_FIELD]: iso };
}

function settingsWith(overrides: Partial<CirclebackSyncSettings>): CirclebackSyncSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("meetingLocal", () => {
  it("runs in America/Chicago, which the date expectations below depend on", () => {
    // `npm test` sets TZ; a bare `npx jest` does not.
    expect(meetingLocal(START).utcOffset()).toBe(-300);
  });

  it("gives the meeting's start in local time", () => {
    expect(meetingLocal(START).format("YYYY-MM-DD HH:mm:ss")).toBe("2026-10-20 10:59:19");
  });

  it("reports an unreadable timestamp as invalid instead of throwing", () => {
    expect(meetingLocal("not a date").isValid()).toBe(false);
  });
});

describe("sanitizeTitle", () => {
  it("sanitizes wikilink-breaking characters", () => {
    expect(sanitizeTitle("A / B : C # [x] ^y | z")).toBe("A _ B _ C _ _x_ _y _ z");
  });

  it("replaces every character a file name or link cannot hold", () => {
    expect(sanitizeTitle('a\\b*c?d"e<f>g')).toBe("a_b_c_d_e_f_g");
  });

  it("collapses runs of whitespace, newlines and tabs, and trims the ends", () => {
    expect(sanitizeTitle("  Weekly \t sync \n\n notes  ")).toBe("Weekly sync notes");
  });

  it("caps titles at 200 chars", () => {
    const result = sanitizeTitle("a".repeat(300));
    expect(result).toHaveLength(200);
    expect(result).toBe("a".repeat(200));
  });

  it("keeps emoji intact when truncating", () => {
    // The 200-character cut would fall between the two halves of the emoji.
    const result = sanitizeTitle(`${"a".repeat(199)}😀tail`);
    expect(result).toBe("a".repeat(199));
    expect(LONE_SURROGATE.test(result)).toBe(false);
  });

  it("keeps an emoji that fits exactly within the cap", () => {
    const result = sanitizeTitle(`${"a".repeat(198)}😀tail`);
    expect(result).toBe(`${"a".repeat(198)}😀`);
    expect(result).toHaveLength(200);
  });

  it("trims trailing whitespace exposed by the cut", () => {
    expect(sanitizeTitle(`${"a".repeat(199)} tail`)).toBe("a".repeat(199));
  });

  it("leaves emoji in short titles alone", () => {
    expect(sanitizeTitle("Launch 🚀 retro")).toBe("Launch 🚀 retro");
  });

  it("replaces a lone surrogate, which no file system can store", () => {
    const result = sanitizeTitle("a\ud83dz");
    expect(result).toBe("a_z");
    expect(LONE_SURROGATE.test(result)).toBe(false);
  });

  it("replaces control characters", () => {
    expect(sanitizeTitle("a\u0000b\u007fc")).toBe("a_b_c");
  });

  it("strips leading dots so the file is not hidden", () => {
    expect(sanitizeTitle(".env review")).toBe("env review");
    expect(sanitizeTitle("..  . notes")).toBe("notes");
    expect(sanitizeTitle("v1.2 review")).toBe("v1.2 review");
  });

  it("falls back for null and punctuation-only titles", () => {
    expect(sanitizeTitle(null)).toBe("Untitled meeting");
    expect(sanitizeTitle("///")).toBe("Untitled meeting");
  });

  it("falls back for empty, blank, all-underscore and all-dot titles", () => {
    for (const raw of ["", "   ", "___", "/ /", "_ _", ".", "...", ". . ."]) {
      expect(sanitizeTitle(raw)).toBe("Untitled meeting");
    }
  });
});

describe("expandPattern", () => {
  const start = meetingLocal(START);

  it("expands {date} {time} {quarter}", () => {
    expect(expandPattern("{date}", "", start)).toBe("2026-10-20");
    expect(expandPattern("{time}", "", start)).toBe("10-59-19");
    expect(expandPattern("{quarter}", "", start)).toBe("Q4");
  });

  it("expands {title} {year} {month} {day}", () => {
    expect(expandPattern("{title} {year}/{month}/{day}", "Weekly sync", start)).toBe("Weekly sync 2026/10/20");
  });

  it("uses local date across midnight", () => {
    const late = meetingLocal(NEAR_MIDNIGHT);
    expect(expandPattern("{date} {time}", "", late)).toBe("2026-10-27 23-30-00");
    expect(expandPattern("{year}-{month}-{day}", "", late)).toBe("2026-10-27");
  });

  it("uses the offset in force on the meeting's day across DST changes", () => {
    // Clocks go forward at 02:00 CST on 2026-03-08: 08:30Z is 03:30 CDT.
    expect(expandPattern("{date} {time}", "", meetingLocal("2026-03-08T08:30:00Z"))).toBe("2026-03-08 03-30-00");
    // Clocks go back at 02:00 CDT on 2026-11-01: 05:30Z the next day is 23:30 CST on the 1st.
    expect(expandPattern("{date} {time}", "", meetingLocal("2026-11-02T05:30:00Z"))).toBe("2026-11-01 23-30-00");
    // The repeated hour: 06:30Z is 01:30 CDT, 07:30Z is 01:30 CST.
    expect(expandPattern("{time}", "", meetingLocal("2026-11-01T06:30:00Z"))).toBe("01-30-00");
    expect(expandPattern("{time}", "", meetingLocal("2026-11-01T07:30:00Z"))).toBe("01-30-00");
  });

  it("numbers every quarter", () => {
    const quarters = ["2026-01-15T18:00:00Z", "2026-04-15T18:00:00Z", "2026-07-15T18:00:00Z", "2026-12-15T18:00:00Z"];
    expect(quarters.map((iso) => expandPattern("{quarter}", "", meetingLocal(iso)))).toEqual([
      "Q1",
      "Q2",
      "Q3",
      "Q4",
    ]);
  });

  it("expands a variable each time it appears and leaves other text as typed", () => {
    expect(expandPattern("{date}_{date} [{foo}] {Title}", "T", start)).toBe("2026-10-20_2026-10-20 [{foo}] {Title}");
  });

  it("does not expand variables that appear inside the title", () => {
    expect(expandPattern("{title} {date}", "Plan {date} {time}", start)).toBe("Plan {date} {time} 2026-10-20");
  });

  it("inserts the title literally, even when it looks like a replacement pattern", () => {
    expect(expandPattern("{title}", "Cost $& $1 $$ plan", start)).toBe("Cost $& $1 $$ plan");
  });

  it("gives ASCII digits whatever language Obsidian is set to", () => {
    moment.locale("ar");
    try {
      const arabic = meetingLocal(START);
      expect(arabic.format("YYYY")).not.toBe("2026"); // the language really does change digits
      expect(expandPattern("{date} {time} {quarter}", "", arabic)).toBe("2026-10-20 10-59-19 Q4");
    } finally {
      moment.locale("en");
    }
  });
});

describe("subfolderFor", () => {
  const start = meetingLocal(START);

  it.each([
    ["none", ""],
    ["day", "2026-10-20"],
    ["month", "2026-10"],
    ["year-month", "2026/10"],
    ["year-quarter", "2026/Q4"],
  ] as const)("builds the %s subfolder", (pattern, expected) => {
    expect(subfolderFor(pattern, "ignored/{year}", start)).toBe(expected);
  });

  it("expands a custom pattern as typed, with an empty title", () => {
    expect(subfolderFor("custom", "{year}/{quarter}/{title}", start)).toBe("2026/Q4/");
    expect(subfolderFor("custom", "By day/{date}", start)).toBe("By day/2026-10-20");
  });

  it("uses local time", () => {
    expect(subfolderFor("day", "", meetingLocal(NEAR_MIDNIGHT))).toBe("2026-10-27");
  });
});

describe("notePath", () => {
  const settings = settingsWith({ customBaseFolder: "Meetings/Circleback", filenamePattern: "{date} - {title}" });

  it("builds Jorge's note path", () => {
    expect(notePath(settings, meetingAt("Jorge / Sam", START), "Daily")).toBe(
      "Meetings/Circleback/2026-10-20 - Jorge _ Sam.md",
    );
  });

  it("accepts the shape Task 10 has from frontmatter: a name and a start", () => {
    const path = notePath(settings, { name: "Jorge / Sam", createdAt: START }, "Daily");
    expect(path).toBe("Meetings/Circleback/2026-10-20 - Jorge _ Sam.md");
  });

  it("uses the daily notes folder when the base folder type says so", () => {
    const daily = settingsWith({ baseFolderType: "daily-notes", customBaseFolder: "Ignored" });
    expect(notePath(daily, meetingAt("Weekly sync", START), "Daily/2026/10")).toBe("Daily/2026/10/Weekly sync.md");
  });

  it("adds the subfolder between the base folder and the file", () => {
    const monthly = { ...settings, subfolderPattern: "year-month" as const };
    expect(notePath(monthly, meetingAt("Weekly sync", START), "")).toBe(
      "Meetings/Circleback/2026/10/2026-10-20 - Weekly sync.md",
    );
    const custom = { ...settings, subfolderPattern: "custom" as const, customSubfolderPattern: "{year}/{quarter}" };
    expect(notePath(custom, meetingAt("Weekly sync", START), "")).toBe(
      "Meetings/Circleback/2026/Q4/2026-10-20 - Weekly sync.md",
    );
  });

  it("puts the note at the vault root when the base folder is empty", () => {
    const root = settingsWith({ customBaseFolder: "" });
    expect(notePath(root, meetingAt("Weekly sync", START), "")).toBe("Weekly sync.md");
  });

  it("normalizes stray slashes in folders", () => {
    const messy = settingsWith({
      customBaseFolder: "/Meetings//Circleback/",
      subfolderPattern: "custom",
      customSubfolderPattern: "/{year}/",
    });
    expect(notePath(messy, meetingAt("Weekly sync", START), "")).toBe("Meetings/Circleback/2026/Weekly sync.md");
  });

  it("makes a subfolder from a slash the user typed in the pattern, never from the title", () => {
    const nested = settingsWith({ filenamePattern: "{year}/{title}" });
    expect(notePath(nested, meetingAt("Q3 / Q4 plan", START), "")).toBe("Circleback/2026/Q3 _ Q4 plan.md");
  });

  it("uses the fallback title for null and punctuation-only names", () => {
    expect(notePath(settings, meetingAt(null, START), "")).toBe("Meetings/Circleback/2026-10-20 - Untitled meeting.md");
    expect(notePath(settings, meetingAt("###", START), "")).toBe(
      "Meetings/Circleback/2026-10-20 - Untitled meeting.md",
    );
  });

  it("falls back to the title when the filename pattern expands to nothing", () => {
    expect(notePath(settingsWith({ filenamePattern: "" }), meetingAt("Weekly sync", START), "")).toBe(
      "Circleback/Weekly sync.md",
    );
    expect(notePath(settingsWith({ filenamePattern: "  " }), meetingAt("Weekly sync", START), "")).toBe(
      "Circleback/Weekly sync.md",
    );
  });

  it("uses the local date for a meeting near midnight", () => {
    expect(notePath(settings, meetingAt("Late call", NEAR_MIDNIGHT), "")).toBe(
      "Meetings/Circleback/2026-10-27 - Late call.md",
    );
  });

  it("keeps a 300-character title within a valid file name", () => {
    const path = notePath(settings, meetingAt("a".repeat(300), START), "");
    const fileName = path.slice(path.lastIndexOf("/") + 1);
    expect(fileName).toBe(`2026-10-20 - ${"a".repeat(200)}.md`);
  });
});

describe("transcriptPath", () => {
  const meeting = meetingAt("Jorge / Sam", START);
  const base = settingsWith({
    customBaseFolder: "Meetings/Circleback",
    filenamePattern: "{date} - {title}",
    customTranscriptBaseFolder: "Meetings/Transcripts",
  });
  const note = notePath(base, meeting, "");

  it("builds custom-location transcript paths", () => {
    const custom = { ...base, transcriptHandling: "custom-location" as const };
    expect(transcriptPath(custom, meeting, note)).toBe("Meetings/Transcripts/Jorge _ Sam-transcript.md");

    const dated = {
      ...custom,
      transcriptSubfolderPattern: "year-quarter" as const,
      transcriptFilenamePattern: "{date} {title} transcript",
    };
    expect(transcriptPath(dated, meeting, note)).toBe(
      "Meetings/Transcripts/2026/Q4/2026-10-20 Jorge _ Sam transcript.md",
    );

    const customSub = {
      ...custom,
      transcriptSubfolderPattern: "custom" as const,
      customTranscriptSubfolderPattern: "{year}-{month}",
    };
    expect(transcriptPath(customSub, meeting, note)).toBe("Meetings/Transcripts/2026-10/Jorge _ Sam-transcript.md");
  });

  it("builds same-location transcript paths in the note's folder", () => {
    const same = { ...base, transcriptHandling: "same-location" as const, transcriptSubfolderPattern: "day" as const };
    expect(transcriptPath(same, meeting, note)).toBe("Meetings/Circleback/Jorge _ Sam-transcript.md");
    expect(transcriptPath(same, meeting, "Daily/2026/10/Moved.md")).toBe("Daily/2026/10/Jorge _ Sam-transcript.md");
  });

  it("puts a same-location transcript at the vault root beside a note at the root", () => {
    const same = { ...base, transcriptHandling: "same-location" as const };
    expect(transcriptPath(same, meeting, "Moved.md")).toBe("Jorge _ Sam-transcript.md");
  });

  it("returns the note path itself when notes and transcripts share one file", () => {
    const combined = { ...base, transcriptHandling: "combined" as const };
    expect(transcriptPath(combined, meeting, note)).toBe(note);
  });

  it("uses the fallback title and the local date", () => {
    const custom = settingsWith({ transcriptFilenamePattern: "{date} {title}" });
    expect(transcriptPath(custom, meetingAt(null, NEAR_MIDNIGHT), "")).toBe(
      "Circleback/Transcripts/2026-10-27 Untitled meeting.md",
    );
  });
});

describe("collisionCandidate", () => {
  const start = meetingLocal(START);
  const path = "Meetings/Circleback/2026-10-20 - Jorge _ Sam.md";

  it("builds collision candidates", () => {
    expect(collisionCandidate(path, start, 1)).toBe("Meetings/Circleback/2026-10-20 - Jorge _ Sam-2026-10-20_10-59.md");
    expect(collisionCandidate(path, start, 2)).toBe(
      "Meetings/Circleback/2026-10-20 - Jorge _ Sam-2026-10-20_10-59-2.md",
    );
    expect(collisionCandidate(path, start, 13)).toBe(
      "Meetings/Circleback/2026-10-20 - Jorge _ Sam-2026-10-20_10-59-13.md",
    );
  });

  it("treats a count below 1 as the first candidate", () => {
    expect(collisionCandidate(path, start, 0)).toBe(collisionCandidate(path, start, 1));
  });

  it("uses the local time of the meeting", () => {
    expect(collisionCandidate("Late.md", meetingLocal(NEAR_MIDNIGHT), 1)).toBe("Late-2026-10-27_23-30.md");
  });

  it("appends the suffix to a path with no .md extension", () => {
    expect(collisionCandidate("Folder/Name", start, 1)).toBe("Folder/Name-2026-10-20_10-59");
  });

  it("inserts the suffix before the extension only, even when the name has dots", () => {
    expect(collisionCandidate("v1.2 review.md", start, 2)).toBe("v1.2 review-2026-10-20_10-59-2.md");
  });
});
