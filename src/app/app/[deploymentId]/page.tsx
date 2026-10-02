import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { DeployedChat } from '@/components/DeployedChat'
import { PasscodeGate } from '@/components/PasscodeGate'
import { cookieNameFor, verifySession } from '@/lib/deployment-session'
import { getRepository } from '@/lib/repository'
import { visitorScope } from '@/lib/repository/chat-repository'

interface PageProps {
  params: Promise<{ deploymentId: string }>
}

export async function generateMetadata({ params }: PageProps) {
  const { deploymentId } = await params
  const deployment = await getRepository().getDeployment(deploymentId)
  if (!deployment) return { title: 'OpenDots' }

  const channel = await getRepository(visitorScope(deployment)).getChannel(deployment.channelUrl)
  return { title: channel ? `${channel.name} — OpenDots` : 'OpenDots' }
}

/**
 * Standalone view for a deployed conversation.
 *
 * Resolved on the server so an unknown id 404s and a locked one renders the
 * gate before any conversation content reaches the client — the check has to
 * happen here, not in the browser, or the transcript ships regardless.
 */
export default async function DeployedAppPage({ params }: PageProps) {
  const { deploymentId } = await params

  const deployment = await getRepository().getDeployment(deploymentId)
  if (!deployment) notFound()

  const channel = await getRepository(visitorScope(deployment)).getChannel(deployment.channelUrl)
  if (!channel) notFound()

  const jar = await cookies()
  const token = jar.get(cookieNameFor(deploymentId))?.value
  const unlocked = verifySession(token, deploymentId, deployment.passcode)

  if (!unlocked) {
    return <PasscodeGate deploymentId={deploymentId} channelName={channel.name} />
  }

  return (
    <DeployedChat
      channel={channel}
      deploymentId={deploymentId}
      allowPosting={deployment.allowPosting}
    />
  )
}
