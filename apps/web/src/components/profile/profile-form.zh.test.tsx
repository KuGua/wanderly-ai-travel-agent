import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { fixtureProfile as zhProfile } from "@/lib/fixtures/profiles.zh";
import { renderWithIntl } from "@/test/render";

import { ProfileForm } from "./profile-form";

describe("ProfileForm (zh)", () => {
  it("renders the Chinese Nationality field label", () => {
    const profile = zhProfile.profile;
    if (!profile) throw new Error("Fixture Profile is required");
    renderWithIntl(
      <ProfileForm profile={profile} onSave={vi.fn()} isSaving={false} saveError={null} saved={false} />,
      { locale: "zh" },
    );
    expect(screen.getByLabelText("国籍")).toBeInTheDocument();
    expect(screen.getByLabelText("出生日期")).toBeInTheDocument();
  });
});