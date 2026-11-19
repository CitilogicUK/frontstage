export interface Config {
  app: {
    /**
     * Sign-in provider for Frontstage. Guest is for local development.
     * @visibility frontend
     */
    signInProvider?: 'github' | 'guest';
    /**
     * Optional HTTPS page where users can create a Tier 3 review ticket.
     * @visibility frontend
     */
    reviewTicketCreateUrl?: string;
  };
}
