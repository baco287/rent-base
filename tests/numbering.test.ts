// Fortlaufende Nummern: withNumberRetry wiederholt eine Anlage nur bei einer Kollision auf dem Nummernfeld, das sie vergibt.
// Reine Logik ohne Datenbank; die Wettläufe gegen PostgreSQL stehen bei den Vorgängen (Behörde, Wartung, Schadenakte).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isUniqueViolation, withNumberRetry } from "../src/lib/numbering";

/** Wie Prisma P2002 meldet: meta.target ist die Liste der Felder des verletzten Index. */
const p2002 = (...target: string[]) => Object.assign(new Error(`Unique constraint failed on the fields: (${target.map((t) => `\`${t}\``).join(",")})`), { code: "P2002", meta: { target } });

/** Liefert nacheinander die angegebenen Fehler, danach "ok"; zählt die Aufrufe. */
function failing(...errors: unknown[]) {
  let calls = 0;
  const fn = async () => { calls++; if (calls <= errors.length) throw errors[calls - 1]; return "ok"; };
  return { fn, calls: () => calls };
}

test("isUniqueViolation erkennt das Feld im Index, auch caseNumber und maintenanceNumber", () => {
  assert.equal(isUniqueViolation(p2002("tenantId", "number"), "number"), true);
  assert.equal(isUniqueViolation(p2002("tenantId", "caseNumber"), "caseNumber"), true);
  assert.equal(isUniqueViolation(p2002("tenantId", "maintenanceNumber"), "maintenanceNumber"), true);
  assert.equal(isUniqueViolation(p2002("tenantId", "caseNumber"), "number"), false, "caseNumber ist nicht number");
  assert.equal(isUniqueViolation(p2002("damageId"), "caseNumber"), false);
  assert.equal(isUniqueViolation(new Error("x"), "number"), false);
});

test("withNumberRetry: Kollision auf dem vergebenen Nummernfeld wird wiederholt (number, caseNumber, maintenanceNumber)", async () => {
  for (const field of ["number", "caseNumber", "maintenanceNumber"] as const) {
    const f = failing(p2002("tenantId", field), p2002("tenantId", field));
    assert.equal(await withNumberRetry(f.fn, field), "ok", field);
    assert.equal(f.calls(), 3, `${field}: zwei Kollisionen, dritter Versuch gelingt`);
  }
  // Standard bleibt "number": bestehende Aufrufer ohne Feldangabe verhalten sich wie bisher
  const d = failing(p2002("tenantId", "number"));
  assert.equal(await withNumberRetry(d.fn), "ok");
  assert.equal(d.calls(), 2);
});

test("withNumberRetry: andere Eindeutigkeiten und fremde Fehler gehen sofort an den Aufrufer", async () => {
  // Schadenakte: Kollision auf damageId (zweite Akte zum selben Schaden) ist keine Nummernkollision – der Aufrufer liefert die vorhandene Akte
  const other = failing(p2002("damageId"));
  await assert.rejects(() => withNumberRetry(other.fn, "caseNumber"), (e) => isUniqueViolation(e, "damageId"));
  assert.equal(other.calls(), 1);
  // ein anderes Nummernfeld als das vergebene wird nicht wiederholt
  const wrongField = failing(p2002("tenantId", "number"));
  await assert.rejects(() => withNumberRetry(wrongField.fn, "maintenanceNumber"));
  assert.equal(wrongField.calls(), 1);
  const plain = failing(new Error("Datenbank nicht erreichbar"));
  await assert.rejects(() => withNumberRetry(plain.fn, "caseNumber"), /nicht erreichbar/);
  assert.equal(plain.calls(), 1);
});

test("withNumberRetry: nach allen Versuchen wird die letzte Kollision gemeldet, nichts verschluckt", async () => {
  const always = failing(...Array.from({ length: 10 }, () => p2002("tenantId", "caseNumber")));
  await assert.rejects(() => withNumberRetry(always.fn, "caseNumber", 3), (e) => isUniqueViolation(e, "caseNumber"));
  assert.equal(always.calls(), 3);
});
