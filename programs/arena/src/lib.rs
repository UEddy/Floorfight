//! Arena match escrow.
//!
//! Players stake SOL into a match account. A resolver key, held only on the
//! game server, records the result and the hash of the full match log. Winners
//! then pull their payout. If the resolver never settles, every player pulls
//! their stake back.
//!
//! The design question for every instruction was: what can each key steal if
//! it leaks.
//!
//!   Admin      can rotate the resolver, change stake limits and pause. There is
//!              no instruction that moves a lamport to the admin. It cannot
//!              withdraw anything.
//!   Resolver   can decide who among the staked players wins a match it is
//!              settling. It cannot pay anyone outside the roster, cannot pay
//!              more than the pot, cannot settle twice, and cannot settle after
//!              the deadline. A stolen resolver key can misassign a pot between
//!              people who were in the match. It cannot drain the program.
//!   Player     can join, and can claim what the match state says it is owed.
//!
//! Exits are never paused. Pause blocks new matches, joins, locks and
//! settlements, so a compromised resolver can be frozen out, but claims and
//! refunds always work. A pause switch that could trap funds would itself be
//! a way to steal them.
//!
//! Payments are pull, not push. Settlement records who is owed what, and each
//! player claims separately. One account that cannot receive lamports can
//! therefore never block everyone else's payout.
//!
//! The match account stays open after settlement on purpose. It holds the log
//! hash and the placements, which is the on-chain half of the replay audit.
//!
//! Token pots. A match can instead be staked in an SPL token the admin has
//! allowed (TokenMatch, seeds "tmatch"), with the same rules: pull payments,
//! 50/30/20 with dust to first, refunds after the deadline, exits never
//! paused, the resolver never admin and never a player. Classic SPL Token
//! only; a mint with a freeze authority only if the allowlist names it. The
//! pot sits in the match PDA's associated token account, which only this
//! program can sign for. SOL matches, their accounts and their instructions
//! are unchanged.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount};

// Placeholder. Replace by generating the program keypair and running
// `anchor keys sync`, which rewrites this line and Anchor.toml together.
declare_id!("HoktNWjdhuts9nzV76UyqUn6FCqJ57LwAizFYbjD4TCe");

pub const MAX_PLAYERS: usize = 6;
pub const MIN_PLAYERS: u8 = 2;
pub const PLACES: usize = 3;

/// Basis points for second and third place. First place receives the pot minus
/// both, so integer rounding dust always goes to the winner and the three
/// payouts sum to exactly the pot.
pub const SECOND_BPS: u128 = 3_000;
pub const THIRD_BPS: u128 = 2_000;

pub const MIN_JOIN_WINDOW: i64 = 30;
pub const MAX_JOIN_WINDOW: i64 = 3_600;
pub const MIN_SETTLE_WINDOW: i64 = 120;
pub const MAX_SETTLE_WINDOW: i64 = 86_400;

/// Marks an unused placement. Never a valid slot because MAX_PLAYERS is 6.
pub const NO_PLACE: u8 = u8::MAX;

#[program]
pub mod arena {
    use super::*;

    /// One time setup. Only the program's upgrade authority may call this, so
    /// nobody can front-run the deployment and install themselves as admin.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        resolver: Pubkey,
        min_stake: u64,
        max_stake: u64,
        settle_window: i64,
    ) -> Result<()> {
        validate_config(ctx.accounts.admin.key(), resolver, min_stake, max_stake, settle_window)?;

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.resolver = resolver;
        config.min_stake = min_stake;
        config.max_stake = max_stake;
        config.settle_window = settle_window;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_admin: Pubkey,
        resolver: Pubkey,
        min_stake: u64,
        max_stake: u64,
        settle_window: i64,
        paused: bool,
    ) -> Result<()> {
        validate_config(new_admin, resolver, min_stake, max_stake, settle_window)?;

        let config = &mut ctx.accounts.config;
        config.admin = new_admin;
        config.resolver = resolver;
        config.min_stake = min_stake;
        config.max_stake = max_stake;
        config.settle_window = settle_window;
        config.paused = paused;
        Ok(())
    }

    pub fn create_match(
        ctx: Context<CreateMatch>,
        match_id: u64,
        stake: u64,
        max_players: u8,
        join_window: i64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, ArenaError::Paused);
        require!(
            stake >= config.min_stake && stake <= config.max_stake,
            ArenaError::StakeOutOfRange
        );
        require!(
            max_players >= MIN_PLAYERS && (max_players as usize) <= MAX_PLAYERS,
            ArenaError::BadPlayerCount
        );
        require!(
            (MIN_JOIN_WINDOW..=MAX_JOIN_WINDOW).contains(&join_window),
            ArenaError::BadWindow
        );

        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.match_account;
        m.match_id = match_id;
        m.creator = ctx.accounts.creator.key();
        m.stake = stake;
        m.max_players = max_players;
        m.count = 0;
        m.players = [Pubkey::default(); MAX_PLAYERS];
        m.state = MatchState::Open;
        m.join_deadline = now.checked_add(join_window).ok_or(ArenaError::Overflow)?;
        m.settle_deadline = 0;
        m.placements = [NO_PLACE; PLACES];
        m.payouts = [0; PLACES];
        m.claimed = 0;
        m.log_hash = [0; 32];
        m.bump = ctx.bumps.match_account;

        emit!(MatchCreated { match_id, stake, max_players, join_deadline: m.join_deadline });
        Ok(())
    }

    /// Slot is the index in `players`, assigned in join order and fixed on
    /// chain. The game server reads the roster from here, so the slot a player
    /// has in the simulation is the same slot the settlement refers to.
    pub fn join_match(ctx: Context<JoinMatch>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, ArenaError::Paused);

        let player = ctx.accounts.player.key();
        // The resolver decides results. Letting it play in a match it settles
        // is a conflict of interest the program can simply refuse.
        require!(player != config.resolver, ArenaError::ResolverCannotPlay);

        let now = Clock::get()?.unix_timestamp;
        let settle_window = config.settle_window;

        {
            let m = &ctx.accounts.match_account;
            require!(m.state == MatchState::Open, ArenaError::WrongState);
            require!(now <= m.join_deadline, ArenaError::DeadlinePassed);
            require!(m.count < m.max_players, ArenaError::MatchFull);
            require!(
                !m.players[..m.count as usize].contains(&player),
                ArenaError::AlreadyJoined
            );
        }

        let stake = ctx.accounts.match_account.stake;
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.player.to_account_info(),
                    to: ctx.accounts.match_account.to_account_info(),
                },
            ),
            stake,
        )?;

        let m = &mut ctx.accounts.match_account;
        let slot = m.count;
        m.players[slot as usize] = player;
        m.count = slot + 1;

        emit!(PlayerJoined { match_id: m.match_id, player, slot });

        if m.count == m.max_players {
            lock(m, now, settle_window)?;
        }
        Ok(())
    }

    /// Start a match that did not fill. Resolver only, at least two players,
    /// and only while joining is still open.
    pub fn lock_match(ctx: Context<ResolverAction>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, ArenaError::Paused);

        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.match_account;
        require!(m.state == MatchState::Open, ArenaError::WrongState);
        require!(now <= m.join_deadline, ArenaError::DeadlinePassed);
        require!(m.count >= MIN_PLAYERS, ArenaError::BadPlayerCount);

        lock(m, now, config.settle_window)
    }

    /// Record the result.
    ///
    /// `placements` are slot indices, first place first. With three or more
    /// players the top three are paid 50/30/20. With two players the winner
    /// takes the pot, and the remaining entries must be NO_PLACE.
    ///
    /// `log_hash` is sha256 of the canonical match log. Anyone can fetch the
    /// log, replay the simulation, and check these placements against it.
    pub fn settle(ctx: Context<ResolverAction>, placements: [u8; PLACES], log_hash: [u8; 32]) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, ArenaError::Paused);

        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.match_account;
        require!(m.state == MatchState::Locked, ArenaError::WrongState);
        require!(now <= m.settle_deadline, ArenaError::DeadlinePassed);

        let places = if m.count >= 3 { 3 } else { 1 };
        for (i, &p) in placements.iter().enumerate() {
            if i < places {
                // A placement must name a real slot in this match. This is the
                // check that stops a resolver paying anyone outside the roster.
                require!(p < m.count, ArenaError::BadPlacement);
                require!(!placements[..i].contains(&p), ArenaError::BadPlacement);
            } else {
                require!(p == NO_PLACE, ArenaError::BadPlacement);
            }
        }

        let pot = (m.stake as u128)
            .checked_mul(m.count as u128)
            .ok_or(ArenaError::Overflow)?;

        let payouts: [u64; PLACES] = if places == 1 {
            [to_u64(pot)?, 0, 0]
        } else {
            let second = pot * SECOND_BPS / 10_000;
            let third = pot * THIRD_BPS / 10_000;
            let first = pot
                .checked_sub(second)
                .and_then(|v| v.checked_sub(third))
                .ok_or(ArenaError::Overflow)?;
            [to_u64(first)?, to_u64(second)?, to_u64(third)?]
        };

        m.placements = placements;
        m.payouts = payouts;
        m.log_hash = log_hash;
        m.state = MatchState::Settled;

        emit!(MatchSettled { match_id: m.match_id, placements, payouts, log_hash });
        Ok(())
    }

    /// Pull a payout or a refund. Never paused and never reads config, so no
    /// admin action can stop a player getting out what they are owed.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let player = ctx.accounts.player.key();
        let now = Clock::get()?.unix_timestamp;

        let (amount, refund, match_id) = {
            let m = &mut ctx.accounts.match_account;

            let slot = m.players[..m.count as usize]
                .iter()
                .position(|p| *p == player)
                .ok_or(ArenaError::NotAParticipant)?;
            let bit = 1u8 << slot;
            require!(m.claimed & bit == 0, ArenaError::AlreadyClaimed);

            let (amount, refund) = match m.state {
                MatchState::Settled => {
                    let place = m
                        .placements
                        .iter()
                        .position(|&p| p as usize == slot)
                        .ok_or(ArenaError::NothingToClaim)?;
                    (m.payouts[place], false)
                }
                MatchState::Refunding => (m.stake, true),
                // Deadline passed with no lock, or lock with no settlement.
                // Flip to Refunding on the first claim. After that, settle
                // checks state rather than the clock, so a refund and a late
                // settlement can never both happen even if the cluster clock
                // were to step backwards.
                MatchState::Open if now > m.join_deadline => {
                    m.state = MatchState::Refunding;
                    (m.stake, true)
                }
                MatchState::Locked if now > m.settle_deadline => {
                    m.state = MatchState::Refunding;
                    (m.stake, true)
                }
                _ => return err!(ArenaError::NotClaimable),
            };
            require!(amount > 0, ArenaError::NothingToClaim);

            // Mark before moving lamports.
            m.claimed |= bit;
            (amount, refund, m.match_id)
        };

        let from = ctx.accounts.match_account.to_account_info();
        let to = ctx.accounts.player.to_account_info();

        // Payouts come from the tracked pot, never from the account balance, so
        // lamports donated to this account cannot be claimed by anyone. The
        // rent reserve is also untouchable.
        let rent = Rent::get()?.minimum_balance(from.data_len());
        let remaining = from.lamports().checked_sub(amount).ok_or(ArenaError::Overflow)?;
        require!(remaining >= rent, ArenaError::InsufficientPot);

        **from.try_borrow_mut_lamports()? = remaining;
        let credited = to.lamports().checked_add(amount).ok_or(ArenaError::Overflow)?;
        **to.try_borrow_mut_lamports()? = credited;

        emit!(Claimed { match_id, player, amount, refund });
        Ok(())
    }

    /* ------------------------------------------------------ token pots --- */

    /// Admin: allow a mint for token pots, with its own stake range in raw
    /// units. Only a classic SPL Token mint can be named here: `Account<Mint>`
    /// checks the owner is the Token program, so a Token-2022 mint is
    /// refused before this body runs.
    ///
    /// A mint with a freeze authority can have the vault frozen, which traps
    /// every stake in it. So one is refused unless the admin writes down
    /// exactly which freeze authority they are accepting, and it has to be
    /// the one the mint actually has.
    pub fn allow_mint(
        ctx: Context<AllowMint>,
        min_stake: u64,
        max_stake: u64,
        freeze_authority: Option<Pubkey>,
    ) -> Result<()> {
        require!(min_stake > 0 && min_stake <= max_stake, ArenaError::BadConfig);
        let actual: Option<Pubkey> = ctx.accounts.mint.freeze_authority.into();
        require!(actual == freeze_authority, ArenaError::MintFreezeAuthority);

        let allow = &mut ctx.accounts.allow;
        allow.mint = ctx.accounts.mint.key();
        allow.min_stake = min_stake;
        allow.max_stake = max_stake;
        allow.freeze_authority = freeze_authority;
        allow.decimals = ctx.accounts.mint.decimals;
        allow.enabled = true;
        allow.bump = ctx.bumps.allow;
        emit!(MintAllowed { mint: allow.mint, min_stake, max_stake, enabled: true });
        Ok(())
    }

    /// Admin: change an allowed mint's range, or turn it off for new matches.
    /// Matches already created with it are unaffected, and their exits never
    /// read this account.
    pub fn update_mint(
        ctx: Context<UpdateMint>,
        min_stake: u64,
        max_stake: u64,
        freeze_authority: Option<Pubkey>,
        enabled: bool,
    ) -> Result<()> {
        require!(min_stake > 0 && min_stake <= max_stake, ArenaError::BadConfig);
        let actual: Option<Pubkey> = ctx.accounts.mint.freeze_authority.into();
        require!(actual == freeze_authority, ArenaError::MintFreezeAuthority);

        let allow = &mut ctx.accounts.allow;
        allow.min_stake = min_stake;
        allow.max_stake = max_stake;
        allow.freeze_authority = freeze_authority;
        allow.enabled = enabled;
        emit!(MintAllowed { mint: allow.mint, min_stake, max_stake, enabled });
        Ok(())
    }

    /// A match whose pot is in an allowed token. Same rules as create_match,
    /// with the stake range taken from the mint's allowlist entry. The vault
    /// is the associated token account of the match PDA, created here, so
    /// only this program can ever move tokens out of it.
    pub fn create_token_match(
        ctx: Context<CreateTokenMatch>,
        match_id: u64,
        stake: u64,
        max_players: u8,
        join_window: i64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, ArenaError::Paused);
        let allow = &ctx.accounts.allow;
        require!(allow.enabled, ArenaError::MintNotAllowed);
        require!(
            stake >= allow.min_stake && stake <= allow.max_stake,
            ArenaError::StakeOutOfRange
        );
        // Checked again here, not only at allow time: the allowlist entry is
        // a promise about the mint, and this is where money starts to depend
        // on it. (An SPL freeze authority that is None can never be set
        // later, so a mint that passes with none stays that way.)
        let actual: Option<Pubkey> = ctx.accounts.mint.freeze_authority.into();
        require!(actual == allow.freeze_authority, ArenaError::MintFreezeAuthority);
        require!(
            max_players >= MIN_PLAYERS && (max_players as usize) <= MAX_PLAYERS,
            ArenaError::BadPlayerCount
        );
        require!(
            (MIN_JOIN_WINDOW..=MAX_JOIN_WINDOW).contains(&join_window),
            ArenaError::BadWindow
        );

        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.token_match;
        m.match_id = match_id;
        m.creator = ctx.accounts.creator.key();
        m.mint = ctx.accounts.mint.key();
        m.stake = stake;
        m.max_players = max_players;
        m.count = 0;
        m.players = [Pubkey::default(); MAX_PLAYERS];
        m.state = MatchState::Open;
        m.join_deadline = now.checked_add(join_window).ok_or(ArenaError::Overflow)?;
        m.settle_deadline = 0;
        m.placements = [NO_PLACE; PLACES];
        m.payouts = [0; PLACES];
        m.claimed = 0;
        m.log_hash = [0; 32];
        m.bump = ctx.bumps.token_match;

        emit!(TokenMatchCreated { match_id, mint: m.mint, stake, max_players, join_deadline: m.join_deadline });
        Ok(())
    }

    /// Stake into a token match, from a token account of the match's mint
    /// that the player owns, into the match's vault. Same rules as join_match.
    pub fn join_token_match(ctx: Context<JoinTokenMatch>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, ArenaError::Paused);

        let player = ctx.accounts.player.key();
        require!(player != config.resolver, ArenaError::ResolverCannotPlay);

        let now = Clock::get()?.unix_timestamp;
        let settle_window = config.settle_window;
        {
            let m = &ctx.accounts.token_match;
            require!(m.state == MatchState::Open, ArenaError::WrongState);
            require!(now <= m.join_deadline, ArenaError::DeadlinePassed);
            require!(m.count < m.max_players, ArenaError::MatchFull);
            require!(
                !m.players[..m.count as usize].contains(&player),
                ArenaError::AlreadyJoined
            );
        }

        let stake = ctx.accounts.token_match.stake;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.player_tokens.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.player.to_account_info(),
                },
            ),
            stake,
        )?;

        let m = &mut ctx.accounts.token_match;
        let slot = m.count;
        m.players[slot as usize] = player;
        m.count = slot + 1;
        emit!(PlayerJoined { match_id: m.match_id, player, slot });

        if m.count == m.max_players {
            m.state = MatchState::Locked;
            m.settle_deadline = now.checked_add(settle_window).ok_or(ArenaError::Overflow)?;
            emit!(MatchLocked { match_id: m.match_id, count: m.count, settle_deadline: m.settle_deadline });
        }
        Ok(())
    }

    /// lock_match for a token match.
    pub fn lock_token_match(ctx: Context<TokenResolverAction>) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, ArenaError::Paused);

        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.token_match;
        require!(m.state == MatchState::Open, ArenaError::WrongState);
        require!(now <= m.join_deadline, ArenaError::DeadlinePassed);
        require!(m.count >= MIN_PLAYERS, ArenaError::BadPlayerCount);

        m.state = MatchState::Locked;
        m.settle_deadline = now.checked_add(config.settle_window).ok_or(ArenaError::Overflow)?;
        emit!(MatchLocked { match_id: m.match_id, count: m.count, settle_deadline: m.settle_deadline });
        Ok(())
    }

    /// settle for a token match: the same placement rules and the same
    /// 50/30/20 split with the rounding dust to first place.
    pub fn settle_token_match(
        ctx: Context<TokenResolverAction>,
        placements: [u8; PLACES],
        log_hash: [u8; 32],
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, ArenaError::Paused);

        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.token_match;
        require!(m.state == MatchState::Locked, ArenaError::WrongState);
        require!(now <= m.settle_deadline, ArenaError::DeadlinePassed);

        check_placements(&placements, m.count)?;
        let payouts = payouts_for(m.stake, m.count)?;

        m.placements = placements;
        m.payouts = payouts;
        m.log_hash = log_hash;
        m.state = MatchState::Settled;
        emit!(MatchSettled { match_id: m.match_id, placements, payouts, log_hash });
        Ok(())
    }

    /// Pull a payout or a refund from a token match's vault. Never paused,
    /// never reads the config or the allowlist: no admin action can stop a
    /// player getting out what they are owed.
    pub fn claim_token(ctx: Context<ClaimToken>) -> Result<()> {
        let player = ctx.accounts.player.key();
        let now = Clock::get()?.unix_timestamp;

        let (amount, refund, match_id, bump) = {
            let m = &mut ctx.accounts.token_match;
            let slot = m.players[..m.count as usize]
                .iter()
                .position(|p| *p == player)
                .ok_or(ArenaError::NotAParticipant)?;
            let bit = 1u8 << slot;
            require!(m.claimed & bit == 0, ArenaError::AlreadyClaimed);

            let (amount, refund) = match m.state {
                MatchState::Settled => {
                    let place = m
                        .placements
                        .iter()
                        .position(|&p| p as usize == slot)
                        .ok_or(ArenaError::NothingToClaim)?;
                    (m.payouts[place], false)
                }
                MatchState::Refunding => (m.stake, true),
                MatchState::Open if now > m.join_deadline => {
                    m.state = MatchState::Refunding;
                    (m.stake, true)
                }
                MatchState::Locked if now > m.settle_deadline => {
                    m.state = MatchState::Refunding;
                    (m.stake, true)
                }
                _ => return err!(ArenaError::NotClaimable),
            };
            require!(amount > 0, ArenaError::NothingToClaim);
            // Mark before moving tokens.
            m.claimed |= bit;
            (amount, refund, m.match_id, m.bump)
        };

        // Paid from the tracked pot. The vault can hold more than that if
        // somebody sends tokens to it, and nobody can claim those; it can
        // never hold less, because only this instruction moves tokens out.
        require!(ctx.accounts.vault.amount >= amount, ArenaError::InsufficientPot);

        let id = match_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"tmatch", id.as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.player_tokens.to_account_info(),
                    authority: ctx.accounts.token_match.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        emit!(TokenClaimed { match_id, mint: ctx.accounts.token_match.mint, player, amount, refund });
        Ok(())
    }
}

/* ------------------------------------------------------------ helpers --- */

fn lock(m: &mut Match, now: i64, settle_window: i64) -> Result<()> {
    m.state = MatchState::Locked;
    m.settle_deadline = now.checked_add(settle_window).ok_or(ArenaError::Overflow)?;
    emit!(MatchLocked { match_id: m.match_id, count: m.count, settle_deadline: m.settle_deadline });
    Ok(())
}

fn validate_config(
    admin: Pubkey,
    resolver: Pubkey,
    min_stake: u64,
    max_stake: u64,
    settle_window: i64,
) -> Result<()> {
    // The resolver sits on an internet-facing server. Keeping it distinct from
    // the admin means a server compromise cannot also rewrite the config.
    require!(resolver != admin, ArenaError::ResolverIsAdmin);
    require!(resolver != Pubkey::default(), ArenaError::BadConfig);
    require!(min_stake > 0 && min_stake <= max_stake, ArenaError::BadConfig);
    require!(
        (MIN_SETTLE_WINDOW..=MAX_SETTLE_WINDOW).contains(&settle_window),
        ArenaError::BadWindow
    );
    Ok(())
}

fn to_u64(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| error!(ArenaError::Overflow))
}

/* ----------------------------------------------------------- accounts --- */

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ ArenaError::Unauthorized)]
    pub program: Program<'info, crate::program::Arena>,

    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ ArenaError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,

    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ ArenaError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CreateMatch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = creator,
        space = 8 + Match::INIT_SPACE,
        seeds = [b"match", match_id.to_le_bytes().as_ref()],
        bump
    )]
    pub match_account: Account<'info, Match>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinMatch<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()],
        bump = match_account.bump
    )]
    pub match_account: Account<'info, Match>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolverAction<'info> {
    pub resolver: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump, has_one = resolver @ ArenaError::Unauthorized)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()],
        bump = match_account.bump
    )]
    pub match_account: Account<'info, Match>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [b"match", match_account.match_id.to_le_bytes().as_ref()],
        bump = match_account.bump
    )]
    pub match_account: Account<'info, Match>,
}

/* -------------------------------------------------------------- state --- */

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub resolver: Pubkey,
    pub min_stake: u64,
    pub max_stake: u64,
    pub settle_window: i64,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Match {
    pub match_id: u64,
    pub creator: Pubkey,
    pub stake: u64,
    pub max_players: u8,
    pub count: u8,
    pub players: [Pubkey; MAX_PLAYERS],
    pub state: MatchState,
    pub join_deadline: i64,
    pub settle_deadline: i64,
    pub placements: [u8; PLACES],
    pub payouts: [u64; PLACES],
    pub claimed: u8,
    pub log_hash: [u8; 32],
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum MatchState {
    Open,
    Locked,
    Settled,
    Refunding,
}

/* ------------------------------------------------------------- events --- */

#[event]
pub struct MatchCreated {
    pub match_id: u64,
    pub stake: u64,
    pub max_players: u8,
    pub join_deadline: i64,
}

#[event]
pub struct PlayerJoined {
    pub match_id: u64,
    pub player: Pubkey,
    pub slot: u8,
}

#[event]
pub struct MatchLocked {
    pub match_id: u64,
    pub count: u8,
    pub settle_deadline: i64,
}

#[event]
pub struct MatchSettled {
    pub match_id: u64,
    pub placements: [u8; PLACES],
    pub payouts: [u64; PLACES],
    pub log_hash: [u8; 32],
}

#[event]
pub struct Claimed {
    pub match_id: u64,
    pub player: Pubkey,
    pub amount: u64,
    pub refund: bool,
}

/* ------------------------------------------------- token pot helpers --- */

/// The placement rules settle applies, for the token path: a placement names
/// a real slot, no slot twice, and NO_PLACE in every unpaid position.
fn check_placements(placements: &[u8; PLACES], count: u8) -> Result<()> {
    let places = if count >= 3 { 3 } else { 1 };
    for (i, &p) in placements.iter().enumerate() {
        if i < places {
            require!(p < count, ArenaError::BadPlacement);
            require!(!placements[..i].contains(&p), ArenaError::BadPlacement);
        } else {
            require!(p == NO_PLACE, ArenaError::BadPlacement);
        }
    }
    Ok(())
}

/// The split settle applies, in raw units: 50/30/20 with the rounding dust
/// to first, or the whole pot to the winner of a two player match. Checked
/// u128 arithmetic, so a huge stake cannot wrap.
fn payouts_for(stake: u64, count: u8) -> Result<[u64; PLACES]> {
    let pot = (stake as u128).checked_mul(count as u128).ok_or(ArenaError::Overflow)?;
    if count < 3 {
        return Ok([to_u64(pot)?, 0, 0]);
    }
    let second = pot.checked_mul(SECOND_BPS).ok_or(ArenaError::Overflow)? / 10_000;
    let third = pot.checked_mul(THIRD_BPS).ok_or(ArenaError::Overflow)? / 10_000;
    let first = pot
        .checked_sub(second)
        .and_then(|v| v.checked_sub(third))
        .ok_or(ArenaError::Overflow)?;
    Ok([to_u64(first)?, to_u64(second)?, to_u64(third)?])
}

/* ----------------------------------------------- token pot accounts --- */

#[derive(Accounts)]
pub struct AllowMint<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ArenaError::Unauthorized)]
    pub config: Account<'info, Config>,

    /// Classic SPL Token only: the owner check on Account<Mint> refuses a
    /// Token-2022 mint.
    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = 8 + MintAllow::INIT_SPACE,
        seeds = [b"mint", mint.key().as_ref()],
        bump
    )]
    pub allow: Account<'info, MintAllow>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateMint<'info> {
    pub admin: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ ArenaError::Unauthorized)]
    pub config: Account<'info, Config>,

    pub mint: Account<'info, Mint>,

    #[account(mut, seeds = [b"mint", mint.key().as_ref()], bump = allow.bump, has_one = mint)]
    pub allow: Account<'info, MintAllow>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CreateTokenMatch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    pub mint: Account<'info, Mint>,

    /// The allowlist entry. Its seeds tie it to this mint: no entry, no
    /// match.
    #[account(seeds = [b"mint", mint.key().as_ref()], bump = allow.bump, has_one = mint)]
    pub allow: Account<'info, MintAllow>,

    #[account(
        init,
        payer = creator,
        space = 8 + TokenMatch::INIT_SPACE,
        seeds = [b"tmatch", match_id.to_le_bytes().as_ref()],
        bump
    )]
    pub token_match: Account<'info, TokenMatch>,

    /// The vault: the match PDA's associated token account for the mint.
    /// init_if_needed rather than init because anyone can create another
    /// account's ATA, and a stranger creating this one first must not be able
    /// to block the match. Either way the address, mint and authority are
    /// checked, so it is the PDA's account and nobody else's.
    #[account(
        init_if_needed,
        payer = creator,
        associated_token::mint = mint,
        associated_token::authority = token_match,
        associated_token::token_program = token_program,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinTokenMatch<'info> {
    pub player: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"tmatch", token_match.match_id.to_le_bytes().as_ref()],
        bump = token_match.bump,
        has_one = mint
    )]
    pub token_match: Account<'info, TokenMatch>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = token_match,
        associated_token::token_program = token_program,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Where the stake comes from: the match's mint, owned by the player.
    #[account(mut, token::mint = mint, token::authority = player, token::token_program = token_program)]
    pub player_tokens: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct TokenResolverAction<'info> {
    pub resolver: Signer<'info>,

    #[account(seeds = [b"config"], bump = config.bump, has_one = resolver @ ArenaError::Unauthorized)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"tmatch", token_match.match_id.to_le_bytes().as_ref()],
        bump = token_match.bump
    )]
    pub token_match: Account<'info, TokenMatch>,
}

#[derive(Accounts)]
pub struct ClaimToken<'info> {
    pub player: Signer<'info>,

    #[account(
        mut,
        seeds = [b"tmatch", token_match.match_id.to_le_bytes().as_ref()],
        bump = token_match.bump,
        has_one = mint
    )]
    pub token_match: Account<'info, TokenMatch>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = token_match,
        associated_token::token_program = token_program,
    )]
    pub vault: Account<'info, TokenAccount>,

    /// Where the payout goes: the match's mint, owned by the player. The
    /// claimer is the signer, so a payout can only ever go to its owner.
    #[account(mut, token::mint = mint, token::authority = player, token::token_program = token_program)]
    pub player_tokens: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// An allowed mint for token pots. Seeds: ["mint", mint].
#[account]
#[derive(InitSpace)]
pub struct MintAllow {
    pub mint: Pubkey,
    /// Stake range in the mint's raw units.
    pub min_stake: u64,
    pub max_stake: u64,
    /// The freeze authority the admin accepted, which must be the mint's own.
    pub freeze_authority: Option<Pubkey>,
    /// The mint's decimals when it was allowed, for anyone displaying amounts.
    pub decimals: u8,
    pub enabled: bool,
    pub bump: u8,
}

/// A match whose pot is in an allowed token. The same fields as Match plus
/// the mint, under its own seeds, so SOL matches and their accounts are
/// untouched. Seeds: ["tmatch", match_id]. Vault: the ATA of this account.
#[account]
#[derive(InitSpace)]
pub struct TokenMatch {
    pub match_id: u64,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub stake: u64,
    pub max_players: u8,
    pub count: u8,
    pub players: [Pubkey; MAX_PLAYERS],
    pub state: MatchState,
    pub join_deadline: i64,
    pub settle_deadline: i64,
    pub placements: [u8; PLACES],
    pub payouts: [u64; PLACES],
    pub claimed: u8,
    pub log_hash: [u8; 32],
    pub bump: u8,
}

#[event]
pub struct MintAllowed {
    pub mint: Pubkey,
    pub min_stake: u64,
    pub max_stake: u64,
    pub enabled: bool,
}

#[event]
pub struct TokenMatchCreated {
    pub match_id: u64,
    pub mint: Pubkey,
    pub stake: u64,
    pub max_players: u8,
    pub join_deadline: i64,
}

#[event]
pub struct TokenClaimed {
    pub match_id: u64,
    pub mint: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
    pub refund: bool,
}

/* ------------------------------------------------------------- errors --- */

#[error_code]
pub enum ArenaError {
    #[msg("Signer is not authorised for this action")]
    Unauthorized,
    #[msg("Program is paused")]
    Paused,
    #[msg("Invalid configuration")]
    BadConfig,
    #[msg("Resolver must be a different key from admin")]
    ResolverIsAdmin,
    #[msg("Stake is outside the allowed range")]
    StakeOutOfRange,
    #[msg("Player count is outside the allowed range")]
    BadPlayerCount,
    #[msg("Window is outside the allowed range")]
    BadWindow,
    #[msg("Match is not in the right state for this action")]
    WrongState,
    #[msg("Deadline has passed")]
    DeadlinePassed,
    #[msg("Match is full")]
    MatchFull,
    #[msg("Wallet has already joined this match")]
    AlreadyJoined,
    #[msg("The resolver cannot play in matches")]
    ResolverCannotPlay,
    #[msg("Placements are invalid")]
    BadPlacement,
    #[msg("Wallet is not a participant in this match")]
    NotAParticipant,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Not claimable yet")]
    NotClaimable,
    #[msg("Match account does not hold enough to pay")]
    InsufficientPot,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("This mint is not allowed for token pots")]
    MintNotAllowed,
    #[msg("The mint's freeze authority is not the one the allowlist accepted")]
    MintFreezeAuthority,
}
