export type GameStatus = "waiting" | "active" | "completed";
export type GuessType = "fourLetter" | "fullWord";
export type AlphabetState = "present" | "absent" | "unknown";
export type PresenceState = "online" | "offline";
export type FriendRequestStatus = "pending" | "accepted" | "declined" | "canceled";
export type GameInviteStatus = "pending" | "accepted" | "declined" | "canceled" | "expired";
export type SocialRelationship = "none" | "friend" | "incoming_request" | "outgoing_request";

export interface AuthUser {
  id: string;
  email: string | null;
  username: string;
  isAnonymous: boolean;
  createdAt: number;
}

export interface PublicLobby {
  code: string;
  host: string;
  createdAt: number;
  players: number;
}

export interface RecentGameSummary {
  gameId: string;
  code: string;
  status: GameStatus;
  public: boolean;
  createdAt: number;
  lastActivityAt: number;
  completedAt?: number;
  opponentName?: string;
  isMyTurnToWait: boolean;
  isExpired: boolean;
}

export interface GuessView {
  id: string;
  playerId: string;
  type: GuessType;
  text: string;
  matchCount: number;
  isCorrect: boolean;
  guessNumber: number;
  createdAt: number;
}

export interface GameStateView {
  game: {
    id: string;
    code: string;
    status: GameStatus;
    public: boolean;
    createdAt: number;
    lastActivityAt: number;
    completedAt?: number;
    winnerId?: string;
  };
  me: {
    id: string;
    username: string;
    alphabet: Record<string, AlphabetState>;
    totalGuesses: number;
    secretWord?: string;
  };
  opponent: null | {
    id: string;
    username: string;
    totalGuesses: number;
    secretWord?: string;
  };
  myGuesses: GuessView[];
  opponentPresentLetterCount: number | null;
  canChat: boolean;
  presence: {
    me: PresenceState;
    opponent: PresenceState | null;
  };
}

export interface LeaderboardEntry {
  username: string;
  wins: number;
  averageGuessesPerWin: number;
  gamesPlayed: number;
  currentWinStreak: number;
  winRate: number;
  bestWinGuesses?: number;
  recentResults: Array<"W" | "L">;
}

export interface ChatMessageView {
  id: string;
  gameId: string;
  playerId: string;
  username: string;
  text: string;
  createdAt: number;
}

export interface WordValidationResult {
  valid: boolean;
  normalizedWord: string;
  reason: string;
  expectedLength?: 4 | 5;
}

export interface SocialUserSummary {
  userId: string;
  username: string;
  displayName: string;
  email: string | null;
  isAnonymous: boolean;
  createdAt: number;
}

export interface SocialSearchResult extends SocialUserSummary {
  relationship: SocialRelationship;
}

export interface FriendView extends SocialUserSummary {
  friendshipId: string;
  since: number;
}

export interface FriendRequestView {
  requestId: string;
  direction: "incoming" | "outgoing";
  status: FriendRequestStatus;
  createdAt: number;
  respondedAt?: number;
  sender: SocialUserSummary;
  receiver: SocialUserSummary;
}

export interface InvitableGameView {
  gameId: string;
  code: string;
  public: boolean;
  createdAt: number;
  status: "waiting";
}

export interface GameInviteView {
  inviteId: string;
  status: GameInviteStatus;
  createdAt: number;
  respondedAt?: number;
  gameId: string;
  gameCode: string;
  gameStatus: GameStatus;
  sender: SocialUserSummary;
  receiver: SocialUserSummary;
  hostUserId: string;
  hostDisplayName: string;
  public: boolean;
}

export interface SocialOverview {
  friends: FriendView[];
  incomingRequests: FriendRequestView[];
  outgoingRequests: FriendRequestView[];
  incomingGameInvites: GameInviteView[];
  outgoingGameInvites: GameInviteView[];
  invitableGames: InvitableGameView[];
}
