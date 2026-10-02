'use client'

import { OrganizationSwitcher, UserButton } from '@clerk/nextjs'

/**
 * The workspace switcher (a team, or personal) and the account menu. Its own
 * module so BotList can load it on demand: local mode never ships Clerk's UI.
 * Switching navigates home, which reloads the bot list for the new workspace.
 */
export default function ClerkAccount() {
  return (
    <div className="flex items-center justify-between gap-2 px-1.5 py-1.5">
      <OrganizationSwitcher hidePersonal={false} afterSelectOrganizationUrl="/" afterSelectPersonalUrl="/" />
      <UserButton />
    </div>
  )
}
