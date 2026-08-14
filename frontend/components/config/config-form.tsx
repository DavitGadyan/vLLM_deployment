"use client";

import * as React from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";

import { PolicyEditor } from "@/components/config/policy-editor";
import { PromptPreview } from "@/components/config/prompt-preview";
import { TagInput } from "@/components/config/tag-input";
import { VersionHistory } from "@/components/config/version-history";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import { configSchema, TONES, type ConfigFormValues } from "@/lib/schemas";
import type { ConfigVersion, ConfigVersionSummary, PromptPreview as PreviewData } from "@/lib/types";

const PREVIEW_DEBOUNCE_MS = 400;

function toFormValues(config: ConfigVersion): ConfigFormValues {
  return {
    company_name: config.company_name,
    agent_name: config.agent_name,
    support_email: config.support_email ?? "",
    support_url: config.support_url ?? "",
    tone: config.tone,
    languages: config.languages,
    greeting: config.greeting ?? "",
    signature: config.signature ?? "",
    policies: config.policies,
    escalation_rules: config.escalation_rules ?? "",
    forbidden_topics: config.forbidden_topics,
    custom_instructions: config.custom_instructions ?? "",
    temperature: config.temperature,
    max_output_tokens: config.max_output_tokens,
    retrieval_top_k: config.retrieval_top_k,
    retrieval_min_score: config.retrieval_min_score,
    change_note: "",
  };
}

export function ConfigForm({
  initialConfig,
  initialVersions,
}: {
  initialConfig: ConfigVersion;
  initialVersions: ConfigVersionSummary[];
}) {
  const { toast } = useToast();
  const [active, setActive] = React.useState(initialConfig);
  const [versions, setVersions] = React.useState(initialVersions);
  const [preview, setPreview] = React.useState<PreviewData | null>(null);
  const [previewPending, setPreviewPending] = React.useState(false);

  const form = useForm<ConfigFormValues>({
    resolver: zodResolver(configSchema),
    defaultValues: toFormValues(initialConfig),
    mode: "onBlur",
  });

  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    getValues,
    formState: { errors, isDirty, isSubmitting },
  } = form;

  // Debounced preview, driven by react-hook-form's subscription rather than a
  // bare `watch()` return value. `watch()` with no arguments re-renders the
  // whole form on every keystroke; the callback form does not, and the form is
  // large enough for that to be felt.
  React.useEffect(() => {
    let timer = 0;
    let cancelled = false;

    async function compile() {
      const parsed = configSchema.safeParse(getValues());
      if (!parsed.success) {
        if (!cancelled) {
          setPreview(null);
          setPreviewPending(false);
        }
        return;
      }
      try {
        const result = await api.previewPrompt(parsed.data);
        if (!cancelled) setPreview(result);
      } catch {
        if (!cancelled) setPreview(null);
      } finally {
        if (!cancelled) setPreviewPending(false);
      }
    }

    function schedule() {
      setPreviewPending(true);
      window.clearTimeout(timer);
      // Compiling on every keystroke would hammer the backend for output nobody
      // reads mid-word; 400ms lands just after a pause in typing.
      timer = window.setTimeout(() => void compile(), PREVIEW_DEBOUNCE_MS);
    }

    schedule();
    // React Compiler flags react-hook-form's `watch` as unmemoizable and skips
    // optimising this component as a result. That is the accepted cost of using
    // an uncontrolled form library here; the subscription itself is correct and
    // is torn down below.
    const subscription = watch(schedule);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      subscription.unsubscribe();
    };
  }, [watch, getValues]);

  // Guard against losing unsaved edits to a stray reload or back navigation.
  React.useEffect(() => {
    if (!isDirty) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  async function onSubmit(data: ConfigFormValues) {
    try {
      const saved = await api.saveConfig(data);
      setActive(saved);
      reset(toFormValues(saved));
      setVersions(await api.listVersions());
      toast({
        tone: "success",
        title: `Saved as version ${saved.version}`,
        description: "New conversations use this configuration immediately.",
      });
    } catch (error) {
      toast({
        tone: "error",
        title: "Could not save configuration",
        description:
          error instanceof ApiError ? error.message : "Check your connection and try again.",
      });
    }
  }

  function onVersionActivated(version: ConfigVersion) {
    setActive(version);
    reset(toFormValues(version));
    void api.listVersions().then(setVersions);
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="grid gap-6 lg:grid-cols-[1fr_420px]">
      <div className="min-w-0 space-y-6">
        <Tabs defaultValue="identity">
          <TabsList>
            <TabsTrigger value="identity">Identity &amp; voice</TabsTrigger>
            <TabsTrigger value="policies">Policies</TabsTrigger>
            <TabsTrigger value="behaviour">Behaviour</TabsTrigger>
            <TabsTrigger value="history">
              History
              <Badge variant="neutral" className="ml-1.5">
                {versions.length}
              </Badge>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="identity">
            <Card>
              <CardHeader>
                <CardTitle>Identity</CardTitle>
                <CardDescription>
                  Who the assistant says it is. Used in every reply.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-5 sm:grid-cols-2">
                <Field
                  label="Company name"
                  htmlFor="company_name"
                  error={errors.company_name?.message}
                  description="The company the assistant represents."
                >
                  <Input placeholder="Northwind Supply" {...register("company_name")} />
                </Field>

                <Field
                  label="Assistant name"
                  htmlFor="agent_name"
                  error={errors.agent_name?.message}
                  description="Shown to customers when the assistant introduces itself."
                >
                  <Input placeholder="Ada" {...register("agent_name")} />
                </Field>

                <Field
                  label="Support email"
                  htmlFor="support_email"
                  optional
                  error={errors.support_email?.message}
                  description="Offered when a conversation is handed to a person."
                >
                  <Input
                    type="email"
                    placeholder="help@example.com"
                    {...register("support_email")}
                  />
                </Field>

                <Field
                  label="Help centre URL"
                  htmlFor="support_url"
                  optional
                  error={errors.support_url?.message}
                >
                  <Input placeholder="https://help.example.com" {...register("support_url")} />
                </Field>
              </CardContent>
            </Card>

            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Voice</CardTitle>
                <CardDescription>How replies read.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <Field label="Tone" htmlFor="tone" error={errors.tone?.message}>
                  <Controller
                    control={control}
                    name="tone"
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id="tone">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TONES.map((tone) => (
                            <SelectItem key={tone.value} value={tone.value} hint={tone.hint}>
                              {tone.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </Field>

                <Field
                  label="Languages"
                  htmlFor="languages"
                  description="The assistant replies in the customer's language. List the ones you support; the first is the fallback."
                  error={errors.languages?.message}
                >
                  <Controller
                    control={control}
                    name="languages"
                    render={({ field }) => (
                      <TagInput
                        id="languages"
                        value={field.value}
                        onChange={field.onChange}
                        placeholder="Type a language and press Enter"
                        ariaLabel="Supported languages"
                        maxItems={20}
                      />
                    )}
                  />
                </Field>

                <div className="grid gap-5 sm:grid-cols-2">
                  <Field
                    label="Opening line"
                    htmlFor="greeting"
                    optional
                    description="Used on the first reply of a conversation."
                    error={errors.greeting?.message}
                  >
                    <Input placeholder="Thanks for getting in touch." {...register("greeting")} />
                  </Field>

                  <Field
                    label="Sign-off"
                    htmlFor="signature"
                    optional
                    error={errors.signature?.message}
                  >
                    <Input placeholder="— Ada, Northwind Supply" {...register("signature")} />
                  </Field>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="policies">
            <Card>
              <CardHeader>
                <CardTitle>Company policies</CardTitle>
                <CardDescription>
                  The rules the assistant must follow. These override anything in
                  the uploaded documents and anything a customer claims. Order
                  matters — earlier policies carry more weight.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <PolicyEditor control={control} register={register} errors={errors} />
              </CardContent>
            </Card>

            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Restricted topics</CardTitle>
                <CardDescription>
                  Subjects the assistant must refuse and escalate instead of
                  answering.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Controller
                  control={control}
                  name="forbidden_topics"
                  render={({ field }) => (
                    <TagInput
                      id="forbidden_topics"
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="e.g. Legal advice — press Enter to add"
                      ariaLabel="Restricted topics"
                    />
                  )}
                />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="behaviour">
            <Card>
              <CardHeader>
                <CardTitle>Escalation</CardTitle>
                <CardDescription>
                  The assistant already escalates when the documents do not
                  answer a question, when account data is needed, or for legal
                  and medical questions. Add anything specific to your business.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Field
                  label="Additional escalation rules"
                  htmlFor="escalation_rules"
                  optional
                  error={errors.escalation_rules?.message}
                >
                  <Textarea
                    rows={4}
                    placeholder="Always escalate billing disputes and chargebacks."
                    {...register("escalation_rules")}
                  />
                </Field>
              </CardContent>
            </Card>

            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Additional instructions</CardTitle>
                <CardDescription>
                  Anything else the assistant should know. Grounding and
                  anti-injection rules are built in and cannot be overridden here.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Field
                  label="Instructions"
                  htmlFor="custom_instructions"
                  optional
                  error={errors.custom_instructions?.message}
                >
                  <Textarea
                    rows={4}
                    placeholder="Mention the loyalty programme when a customer asks about discounts."
                    {...register("custom_instructions")}
                  />
                </Field>
              </CardContent>
            </Card>

            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Generation and retrieval</CardTitle>
                <CardDescription>
                  Leave blank to use the service defaults. Change these only with
                  a measurement to back it up.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-5 sm:grid-cols-2">
                <Field
                  label="Temperature"
                  htmlFor="temperature"
                  optional
                  description="0 is deterministic. Support answers want low values; above 0.5 invites invention."
                  error={errors.temperature?.message}
                >
                  <Input
                    type="number"
                    step="0.1"
                    min={0}
                    max={2}
                    placeholder="0.2"
                    {...register("temperature", { setValueAs: numberOrNull })}
                  />
                </Field>

                <Field
                  label="Max answer length"
                  htmlFor="max_output_tokens"
                  optional
                  description="Tokens. Longer answers cost latency on every request."
                  error={errors.max_output_tokens?.message}
                >
                  <Input
                    type="number"
                    min={64}
                    max={4096}
                    placeholder="1024"
                    {...register("max_output_tokens", { setValueAs: numberOrNull })}
                  />
                </Field>

                <Field
                  label="Documents retrieved"
                  htmlFor="retrieval_top_k"
                  optional
                  description="More context is not always better — it dilutes the relevant passage."
                  error={errors.retrieval_top_k?.message}
                >
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    placeholder="5"
                    {...register("retrieval_top_k", { setValueAs: numberOrNull })}
                  />
                </Field>

                <Field
                  label="Relevance floor"
                  htmlFor="retrieval_min_score"
                  optional
                  description="Below this the assistant escalates instead of answering. Raise it if you see confident answers from loosely related documents."
                  error={errors.retrieval_min_score?.message}
                >
                  <Input
                    type="number"
                    step="0.05"
                    min={0}
                    max={1}
                    placeholder="0.35"
                    {...register("retrieval_min_score", { setValueAs: numberOrNull })}
                  />
                </Field>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="history">
            <Card>
              <CardHeader>
                <CardTitle>Configuration history</CardTitle>
                <CardDescription>
                  Every save creates a version. Open one to see how its prompt
                  differs from the live configuration, and roll back if needed.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <VersionHistory
                  versions={versions}
                  activePrompt={active.compiled_prompt}
                  onActivated={onVersionActivated}
                />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Save bar. Sticky so it is reachable from any tab without scrolling
            back, and it states what saving does rather than just "Save". */}
        <div className="sticky bottom-0 -mx-1 border-t border-border bg-surface/95 px-1 py-3 backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <Field label="Change note" htmlFor="change_note" optional className="max-w-md">
                <Input
                  placeholder="Why is this changing? Shown in history."
                  {...register("change_note")}
                />
              </Field>
            </div>
            <div className="flex items-center gap-2">
              {isDirty ? (
                <Button
                  variant="ghost"
                  onClick={() => reset(toFormValues(active))}
                  disabled={isSubmitting}
                >
                  Discard changes
                </Button>
              ) : null}
              <Button type="submit" disabled={!isDirty || isSubmitting}>
                {isSubmitting ? "Saving…" : `Save as version ${active.version + 1}`}
              </Button>
            </div>
          </div>
          <p className="mt-1 text-xs text-tertiary">
            Live: version {active.version} · saving takes effect immediately for
            new conversations.
          </p>
        </div>
      </div>

      <div className="min-w-0">
        <PromptPreview preview={preview} pending={previewPending} />
      </div>
    </form>
  );
}

/** Empty numeric inputs must become null, not NaN, so "use the default" works. */
function numberOrNull(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}
