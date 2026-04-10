import { FriendsPanel } from "./FriendsPanel";

interface SocialHubProps {
  className?: string;
}

export function SocialHub({ className = "" }: SocialHubProps) {
  return <FriendsPanel className={className} />;
}
