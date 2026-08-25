import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { fixtureProfile } from "@/lib/fixtures/profiles";
import { renderWithIntl } from "@/test/render";

import {
  ProfileForm,
  profileToFormValues,
  toUpdateProfileInput,
  type ProfileDirtyFields,
} from "./profile-form";

describe("ProfileForm", () => {
  it("maps nullable Profile values into editable empty fields", () => {
    const baseProfile = fixtureProfile.profile;
    if (!baseProfile) throw new Error("Fixture Profile is required");
    const profile = { ...baseProfile, nationality: null, availableDepartureDates: null };

    renderWithIntl(
      <ProfileForm profile={profile} onSave={vi.fn()} isSaving={false} saveError={null} saved={false} />,
    );

    expect(screen.getByLabelText("Nationality")).toHaveValue("");
    expect(screen.getByLabelText("Date of birth")).toHaveValue("");
    expect(screen.getByLabelText("Available departure dates")).toHaveValue("");
  });

  it("builds a strict partial mutation without read-only Profile fields", () => {
    const profile = fixtureProfile.profile;
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
});