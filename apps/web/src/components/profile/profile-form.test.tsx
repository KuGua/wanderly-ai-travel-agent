import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { testProfileResponse } from "@/test/api-fixtures";
import { renderWithIntl } from "@/test/render";

import {
  ProfileForm,
  profileToFormValues,
  toUpdateProfileInput,
  type ProfileDirtyFields,
} from "./profile-form";

// This file had no cleanup, unlike its siblings. Renders accumulated, so a
// test could read a control another test had mounted — which is why an
// assertion about a "cn" Profile was answered by an earlier render's empty
// one, and why the same test passed when run alone.
afterEach(cleanup);

describe("ProfileForm", () => {
  it("maps nullable Profile values into editable empty fields", () => {
    const baseProfile = testProfileResponse.profile;
    if (!baseProfile) throw new Error("Fixture Profile is required");
    const profile = { ...baseProfile, nationality: null, availableDepartureDates: null };

    renderWithIntl(
      <ProfileForm profile={profile} onSave={vi.fn()} isSaving={false} saveError={null} saved={false} />,
    );

    // The control is a listbox, so what it holds is the label it shows. A
    // `toHaveValue` here reads the trigger button's own empty `value` property
    // and would pass whatever the form state is.
    expect(screen.getByLabelText("Nationality")).toHaveTextContent("Select nationality");
    expect(screen.getByLabelText("Date of birth")).toHaveValue("");
    // Available departure dates is no longer an editable field on this form.
    expect(screen.queryByLabelText("Available departure dates")).toBeNull();
  });

  it("treats a Profile nationality the provider cannot use as unset", () => {
    // Written before this field was a picker, and exactly what the form used
    // to ask for: the label said Nationality, `autoComplete` said
    // `country-name`, and 64 characters were allowed. Activation then refused
    // it with a 422 the traveller could not act on, and the picker that
    // produces valid codes hid itself because the field was non-empty. Showing
    // it as unset is what lets someone repair their own record.
    const baseProfile = testProfileResponse.profile;
    if (!baseProfile) throw new Error("Fixture Profile is required");

    renderWithIntl(
      <ProfileForm profile={{ ...baseProfile, nationality: "中国" }} onSave={vi.fn()} isSaving={false} saveError={null} saved={false} />,
    );

    expect(screen.getByLabelText("Nationality")).toHaveTextContent("Select nationality");
  });

  it("keeps a Profile nationality the provider accepts", () => {
    const baseProfile = testProfileResponse.profile;
    if (!baseProfile) throw new Error("Fixture Profile is required");

    renderWithIntl(
      <ProfileForm profile={{ ...baseProfile, nationality: "cn" }} onSave={vi.fn()} isSaving={false} saveError={null} saved={false} />,
    );

    // Normalized on the way in, so the stored casing never decides whether the
    // value survives a round trip through this form.
    expect(screen.getByLabelText("Nationality")).toHaveTextContent("China");
  });

  it("builds a strict partial mutation without read-only Profile fields", () => {
    const profile = testProfileResponse.profile;
    if (!profile) throw new Error("Fixture Profile is required");
    const values = { ...profileToFormValues(profile), budgetMaxUsd: "4200", nationality: "CA" };
    const dirtyFields: ProfileDirtyFields = { budgetMaxUsd: true, nationality: true };

    const input = toUpdateProfileInput(values, dirtyFields);

    expect(input).toEqual({ budgetMaxUsd: 4200, nationality: "CA" });
    expect(input).not.toHaveProperty("id");
    expect(input).not.toHaveProperty("userId");
    expect(input).not.toHaveProperty("displayName");
    expect(input).not.toHaveProperty("createdAt");
    expect(input).not.toHaveProperty("updatedAt");
  });

  it("accepts a compact birth date but sends the API its canonical ISO form", () => {
    const profile = testProfileResponse.profile;
    if (!profile) throw new Error("Fixture Profile is required");

    const input = toUpdateProfileInput(
      { ...profileToFormValues(profile), dateOfBirth: "19830717" },
      { dateOfBirth: true },
    );

    expect(input).toEqual({ dateOfBirth: "1983-07-17" });
  });
});
