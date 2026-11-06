import { getIndustryProfile, listIndustryProfiles } from "../../../../src/server/modules/industry/industry-profile-service";
import { IndustryProfileForm } from "../../../../components/features/settings/industry-profile-form";
import { SettingsNav } from "../../../../components/features/settings/settings-nav";
import { PageHeader } from "../../../../components/ui/page-header";
import { AccessDenied } from "../../../../components/ui/states";
import { getPageContext } from "../../../../lib/server/page-context";

export const metadata = { title: "Manufacturing profile · Operis" };

export default async function IndustryProfilePage() {
  const ctx = await getPageContext();
  if (!ctx.can("industry_profile:manage")) return <AccessDenied what="the manufacturing profile" />;

  const current = await getIndustryProfile(ctx.session);
  const profiles = listIndustryProfiles();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Choosing a profile does not delete or hide any existing data. Switching away from a profile only stops new records of its kind from being created until you switch back."
      />
      <SettingsNav role={ctx.session.role} active="industry-profile" />
      <IndustryProfileForm profiles={profiles} current={{ industryProfile: current.industryProfile, enabledModules: current.enabledModules }} />
    </>
  );
}
