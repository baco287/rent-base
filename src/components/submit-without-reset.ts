"use client";

import { startTransition, type FormEvent } from "react";

/**
 * React leert Formulare nach einer Server-Aktion automatisch. Bei Fehlermeldungen wären dann alle Eingaben weg.
 * Mit diesem onSubmit-Handler bleibt das Formular stehen; Weiterleitungen aus der Aktion funktionieren weiterhin.
 * Der gedrückte Knopf (name/value) wird mit übertragen, damit z. B. "Zurück" und "Weiter" unterscheidbar sind.
 */
export function submitWithoutReset(formAction: (formData: FormData) => void) {
  return (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const formData = new FormData(e.currentTarget, submitter);
    startTransition(() => formAction(formData));
  };
}
