export interface Config {
  app: {
    /**
     * Optional HTTPS page where users can create a Tier 3 review ticket.
     * @visibility frontend
     */
    reviewTicketCreateUrl?: string;
  };
}
