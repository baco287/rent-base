"use client";

import { startTransition, type FormEvent } from "react";

/**
 * React leert Formulare nach einer Server-Aktion automatisch. Bei Fehlermeldungen wären dann alle Eingaben weg.
 * Mit diesem onSubmit-Handler bleibt das Formular stehen; Weiterleitungen aus der Aktion funktionieren weiterhin.
 */
export function submitWithoutReset(formAction: (formData: FormData) => void) {
  return (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    startTransition(() => formAction(formData));
  };
}
