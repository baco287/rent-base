// Startseite: aufklappbare Bereiche. Standard zu, dringend = offen, eigene Wahl bleibt – außer der Bereich wird erst
// nach dem Zuklappen dringend (dann wieder offen, damit nichts Neues untergeht).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOpen } from "../src/app/(app)/heute/dashboard-section";

test("Bereiche: Standard zu, dringend offen, eigene Wahl gilt, neue Dringlichkeit öffnet wieder", () => {
  assert.equal(resolveOpen(null, false), false, "ruhiger Tag: zugeklappt");
  assert.equal(resolveOpen(null, true), true, "etwas überfällig: klappt von selbst auf");
  assert.equal(resolveOpen({ open: true, urgentAtChoice: false }, false), true, "selbst aufgeklappt bleibt offen");
  assert.equal(resolveOpen({ open: false, urgentAtChoice: true }, true), false, "bewusst zugeklappt, obwohl dringend: bleibt zu");
  assert.equal(resolveOpen({ open: false, urgentAtChoice: false }, true), true, "erst danach dringend geworden: wieder offen");
  assert.equal(resolveOpen({ open: true, urgentAtChoice: true }, false), true, "Dringlichkeit vorbei: eigene Wahl bleibt");
});
