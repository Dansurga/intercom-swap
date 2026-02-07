use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    hash::hash,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack,
    pubkey::Pubkey,
    system_instruction,
    sysvar::{clock::Clock, rent::Rent, Sysvar},
};

// Program id for this fork's production deployment.
// Keep this in sync with `src/solana/lnUsdtEscrowClient.js` (`LN_USDT_ESCROW_PROGRAM_ID`).
solana_program::declare_id!("4RS6xpspM1V2K7FKSqeSH6VVaZbtzHzhJqacwrz8gJrF");

const ESCROW_SEED: &[u8] = b"escrow";
const CONFIG_SEED: &[u8] = b"config";
const TRADE_CONFIG_SEED: &[u8] = b"trade_config";
// Fee caps are enforced on-chain (and re-validated during escrow init).
// Basis points: 10_000 = 100%.
const MAX_PLATFORM_FEE_BPS: u16 = 500; // 5%
const MAX_TRADE_FEE_BPS: u16 = 1000; // 10%
const MAX_TOTAL_FEE_BPS: u16 = 1500; // 15% (platform + trade)

#[repr(u32)]
enum EscrowError {
    InvalidInstruction = 1,
    InvalidEscrowPda = 2,
    InvalidVaultAta = 3,
    InvalidTokenAccount = 4,
    InvalidSigner = 5,
    InvalidPreimage = 6,
    NotActive = 7,
    TooEarly = 8,
    InvalidConfigPda = 9,
    InvalidConfigState = 10,
    FeeTooHigh = 11,
    AlreadyInitialized = 12,
    InvalidFeeVaultAta = 13,
    InvalidTradeConfigPda = 14,
    InvalidTradeConfigState = 15,
    InvalidTradeFeeVaultAta = 16,
    FeeMismatch = 17,
}

impl From<EscrowError> for ProgramError {
    fn from(e: EscrowError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
struct EscrowState {
    v: u8,
    status: u8, // 0=active, 1=claimed, 2=refunded
    payment_hash: [u8; 32],
    recipient: [u8; 32],
    refund: [u8; 32],
    refund_after: i64,
    mint: [u8; 32],
    net_amount: u64,
    platform_fee_amount: u64,
    platform_fee_bps: u16,
    platform_fee_collector: [u8; 32],
    trade_fee_amount: u64,
    trade_fee_bps: u16,
    trade_fee_collector: [u8; 32],
    vault: [u8; 32],
    bump: u8,
}

impl EscrowState {
    const V3: u8 = 3;
    const STATUS_ACTIVE: u8 = 0;
    const STATUS_CLAIMED: u8 = 1;
    const STATUS_REFUNDED: u8 = 2;
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
struct ConfigState {
    v: u8,
    authority: [u8; 32],
    fee_collector: [u8; 32],
    fee_bps: u16,
    bump: u8,
}

impl ConfigState {
    const V1: u8 = 1;
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
struct TradeConfigState {
    v: u8,
    authority: [u8; 32],
    fee_collector: [u8; 32],
    fee_bps: u16,
    bump: u8,
}

impl TradeConfigState {
    const V1: u8 = 1;
}

enum EscrowIx {
    Init {
        payment_hash: [u8; 32],
        recipient: Pubkey,
        refund: Pubkey,
        refund_after: i64,
        amount: u64,
        expected_platform_fee_bps: u16,
        expected_trade_fee_bps: u16,
        trade_fee_collector: Pubkey,
    },
    Claim { preimage: [u8; 32] },
    Refund,
    InitConfig { fee_collector: Pubkey, fee_bps: u16 },
    SetConfig { fee_collector: Pubkey, fee_bps: u16 },
    WithdrawFees { amount: u64 },
    InitTradeConfig { fee_collector: Pubkey, fee_bps: u16 },
    SetTradeConfig { fee_collector: Pubkey, fee_bps: u16 },
    WithdrawTradeFees { amount: u64 },
}

fn read_bytes<const N: usize>(data: &mut &[u8]) -> Result<[u8; N], ProgramError> {
    if data.len() < N {
        return Err(EscrowError::InvalidInstruction.into());
    }
    let (head, tail) = data.split_at(N);
    *data = tail;
    let mut out = [0u8; N];
    out.copy_from_slice(head);
    Ok(out)
}

fn read_u64_le(data: &mut &[u8]) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(read_bytes::<8>(data)?))
}

fn read_i64_le(data: &mut &[u8]) -> Result<i64, ProgramError> {
    Ok(i64::from_le_bytes(read_bytes::<8>(data)?))
}

fn read_u16_le(data: &mut &[u8]) -> Result<u16, ProgramError> {
    Ok(u16::from_le_bytes(read_bytes::<2>(data)?))
}

fn parse_ix(input: &[u8]) -> Result<EscrowIx, ProgramError> {
    let mut data = input;
    if data.is_empty() {
        return Err(EscrowError::InvalidInstruction.into());
    }
    let tag = data[0];
    data = &data[1..];
    match tag {
        0 => {
            let payment_hash = read_bytes::<32>(&mut data)?;
            let recipient = Pubkey::new_from_array(read_bytes::<32>(&mut data)?);
            let refund = Pubkey::new_from_array(read_bytes::<32>(&mut data)?);
            let refund_after = read_i64_le(&mut data)?;
            let amount = read_u64_le(&mut data)?;
            let expected_platform_fee_bps = read_u16_le(&mut data)?;
            let expected_trade_fee_bps = read_u16_le(&mut data)?;
            let trade_fee_collector = Pubkey::new_from_array(read_bytes::<32>(&mut data)?);
            Ok(EscrowIx::Init {
                payment_hash,
                recipient,
                refund,
                refund_after,
                amount,
                expected_platform_fee_bps,
                expected_trade_fee_bps,
                trade_fee_collector,
            })
        }
        1 => {
            let preimage = read_bytes::<32>(&mut data)?;
            Ok(EscrowIx::Claim { preimage })
        }
        2 => Ok(EscrowIx::Refund),
        3 => {
            let fee_collector = Pubkey::new_from_array(read_bytes::<32>(&mut data)?);
            let fee_bps = read_u16_le(&mut data)?;
            Ok(EscrowIx::InitConfig { fee_collector, fee_bps })
        }
        4 => {
            let fee_collector = Pubkey::new_from_array(read_bytes::<32>(&mut data)?);
            let fee_bps = read_u16_le(&mut data)?;
            Ok(EscrowIx::SetConfig { fee_collector, fee_bps })
        }
        5 => {
            let amount = read_u64_le(&mut data)?;
            Ok(EscrowIx::WithdrawFees { amount })
        }
        6 => {
            let fee_collector = Pubkey::new_from_array(read_bytes::<32>(&mut data)?);
            let fee_bps = read_u16_le(&mut data)?;
            Ok(EscrowIx::InitTradeConfig { fee_collector, fee_bps })
        }
        7 => {
            let fee_collector = Pubkey::new_from_array(read_bytes::<32>(&mut data)?);
            let fee_bps = read_u16_le(&mut data)?;
            Ok(EscrowIx::SetTradeConfig { fee_collector, fee_bps })
        }
        8 => {
            let amount = read_u64_le(&mut data)?;
            Ok(EscrowIx::WithdrawTradeFees { amount })
        }
        _ => Err(EscrowError::InvalidInstruction.into()),
    }
}

fn assert_signer(ai: &AccountInfo) -> Result<(), ProgramError> {
    if !ai.is_signer {
        return Err(EscrowError::InvalidSigner.into());
    }
    Ok(())
}

fn assert_writable(ai: &AccountInfo) -> Result<(), ProgramError> {
    if !ai.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

fn pda_for_hash(program_id: &Pubkey, payment_hash: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ESCROW_SEED, payment_hash], program_id)
}

fn config_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CONFIG_SEED], program_id)
}

fn trade_config_pda(program_id: &Pubkey, fee_collector: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[TRADE_CONFIG_SEED, fee_collector.as_ref()], program_id)
}

fn require_active(state: &EscrowState) -> Result<(), ProgramError> {
    if state.status != EscrowState::STATUS_ACTIVE {
        return Err(EscrowError::NotActive.into());
    }
    Ok(())
}

entrypoint!(process_instruction);

fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], instruction_data: &[u8]) -> ProgramResult {
    let ix = parse_ix(instruction_data)?;
    match ix {
        EscrowIx::Init {
            payment_hash,
            recipient,
            refund,
            refund_after,
            amount,
            expected_platform_fee_bps,
            expected_trade_fee_bps,
            trade_fee_collector,
        } => process_init(
            program_id,
            accounts,
            payment_hash,
            recipient,
            refund,
            refund_after,
            amount,
            expected_platform_fee_bps,
            expected_trade_fee_bps,
            trade_fee_collector,
        ),
        EscrowIx::Claim { preimage } => process_claim(program_id, accounts, preimage),
        EscrowIx::Refund => process_refund(program_id, accounts),
        EscrowIx::InitConfig {
            fee_collector,
            fee_bps,
        } => process_init_config(program_id, accounts, fee_collector, fee_bps),
        EscrowIx::SetConfig {
            fee_collector,
            fee_bps,
        } => process_set_config(program_id, accounts, fee_collector, fee_bps),
        EscrowIx::WithdrawFees { amount } => process_withdraw_fees(program_id, accounts, amount),
        EscrowIx::InitTradeConfig {
            fee_collector,
            fee_bps,
        } => process_init_trade_config(program_id, accounts, fee_collector, fee_bps),
        EscrowIx::SetTradeConfig {
            fee_collector,
            fee_bps,
        } => process_set_trade_config(program_id, accounts, fee_collector, fee_bps),
        EscrowIx::WithdrawTradeFees { amount } => process_withdraw_trade_fees(program_id, accounts, amount),
    }
}

fn process_init_trade_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    fee_collector: Pubkey,
    fee_bps: u16,
) -> ProgramResult {
    // Accounts:
    // 0 [signer,writable] payer (also trade config authority)
    // 1 [writable] trade config PDA (seeded by fee_collector)
    // 2 [] system program
    // 3 [] rent sysvar
    let acc_iter = &mut accounts.iter();
    let payer = next_account_info(acc_iter)?;
    let trade_config = next_account_info(acc_iter)?;
    let system_program = next_account_info(acc_iter)?;
    let rent_sysvar = next_account_info(acc_iter)?;

    assert_signer(payer)?;
    assert_writable(payer)?;
    assert_writable(trade_config)?;

    if fee_bps > MAX_TRADE_FEE_BPS {
        msg!("fee_bps too high");
        return Err(EscrowError::FeeTooHigh.into());
    }
    if *payer.key != fee_collector {
        msg!("fee_collector must be the trade config authority");
        return Err(EscrowError::InvalidSigner.into());
    }

    let (expected_trade_cfg, bump) = trade_config_pda(program_id, &fee_collector);
    if expected_trade_cfg != *trade_config.key {
        msg!("trade config PDA mismatch");
        return Err(EscrowError::InvalidTradeConfigPda.into());
    }

    if !trade_config.data_is_empty() {
        msg!("trade config already initialized");
        return Err(EscrowError::AlreadyInitialized.into());
    }

    let rent = Rent::from_account_info(rent_sysvar)?;
    let space = 1usize + 32 + 32 + 2 + 1; // TradeConfigState layout
    let lamports = rent.minimum_balance(space);
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            trade_config.key,
            lamports,
            space as u64,
            program_id,
        ),
        &[payer.clone(), trade_config.clone(), system_program.clone()],
        &[&[TRADE_CONFIG_SEED, fee_collector.as_ref(), &[bump]]],
    )?;

    let state = TradeConfigState {
        v: TradeConfigState::V1,
        authority: payer.key.to_bytes(),
        fee_collector: fee_collector.to_bytes(),
        fee_bps,
        bump,
    };
    state
        .serialize(&mut &mut trade_config.try_borrow_mut_data()?[..])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(())
}

fn process_set_trade_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    fee_collector: Pubkey,
    fee_bps: u16,
) -> ProgramResult {
    // Accounts:
    // 0 [signer] authority
    // 1 [writable] trade config PDA
    let acc_iter = &mut accounts.iter();
    let authority = next_account_info(acc_iter)?;
    let trade_config = next_account_info(acc_iter)?;

    assert_signer(authority)?;
    assert_writable(trade_config)?;

    if fee_bps > MAX_TRADE_FEE_BPS {
        msg!("fee_bps too high");
        return Err(EscrowError::FeeTooHigh.into());
    }
    if *authority.key != fee_collector {
        msg!("fee_collector must be the trade config authority");
        return Err(EscrowError::InvalidSigner.into());
    }

    let (expected_trade_cfg, bump) = trade_config_pda(program_id, &fee_collector);
    if expected_trade_cfg != *trade_config.key {
        msg!("trade config PDA mismatch");
        return Err(EscrowError::InvalidTradeConfigPda.into());
    }

    let mut state = TradeConfigState::try_from_slice(&trade_config.try_borrow_data()?)
        .map_err(|_| EscrowError::InvalidTradeConfigState)?;
    if state.v != TradeConfigState::V1 || state.bump != bump {
        msg!("trade config state version/bump mismatch");
        return Err(EscrowError::InvalidTradeConfigState.into());
    }
    if Pubkey::new_from_array(state.authority) != *authority.key {
        msg!("trade config authority mismatch");
        return Err(EscrowError::InvalidSigner.into());
    }

    state.fee_collector = fee_collector.to_bytes();
    state.fee_bps = fee_bps;
    state
        .serialize(&mut &mut trade_config.try_borrow_mut_data()?[..])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(())
}

fn process_withdraw_trade_fees(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    // Accounts:
    // 0 [signer] fee collector (trade config authority)
    // 1 [] trade config PDA
    // 2 [writable] trade fee vault ATA (ATA(owner=trade config PDA, mint=configured mint))
    // 3 [writable] fee collector token account (destination)
    // 4 [] token program
    let acc_iter = &mut accounts.iter();
    let fee_collector = next_account_info(acc_iter)?;
    let trade_config = next_account_info(acc_iter)?;
    let fee_vault = next_account_info(acc_iter)?;
    let dest_token = next_account_info(acc_iter)?;
    let token_program = next_account_info(acc_iter)?;

    assert_signer(fee_collector)?;
    assert_writable(fee_vault)?;
    assert_writable(dest_token)?;

    // Validate trade config PDA from signer.
    let (expected_trade_cfg, bump) = trade_config_pda(program_id, fee_collector.key);
    if expected_trade_cfg != *trade_config.key {
        msg!("trade config PDA mismatch");
        return Err(EscrowError::InvalidTradeConfigPda.into());
    }

    let state = TradeConfigState::try_from_slice(&trade_config.try_borrow_data()?)
        .map_err(|_| EscrowError::InvalidTradeConfigState)?;
    if state.v != TradeConfigState::V1 || state.bump != bump {
        msg!("trade config state version/bump mismatch");
        return Err(EscrowError::InvalidTradeConfigState.into());
    }

    let auth_pk = Pubkey::new_from_array(state.authority);
    if auth_pk != *fee_collector.key {
        msg!("withdraw signer mismatch");
        return Err(EscrowError::InvalidSigner.into());
    }
    let collector_pk = Pubkey::new_from_array(state.fee_collector);
    if collector_pk != *fee_collector.key {
        msg!("fee_collector mismatch");
        return Err(EscrowError::InvalidSigner.into());
    }

    // Validate fee vault ATA matches ATA(owner=trade config PDA, mint=fee vault mint).
    let fee_vault_state = spl_token::state::Account::unpack(&fee_vault.try_borrow_data()?)
        .map_err(|_| EscrowError::InvalidTokenAccount)?;
    if fee_vault_state.owner != *trade_config.key {
        msg!("fee vault owner mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }
    let mint_pk = fee_vault_state.mint;
    let expected_fee_vault =
        spl_associated_token_account::get_associated_token_address(trade_config.key, &mint_pk);
    if expected_fee_vault != *fee_vault.key {
        msg!("fee vault ATA mismatch");
        return Err(EscrowError::InvalidTradeFeeVaultAta.into());
    }

    // Validate destination token account: same mint, owned by collector.
    let dest_state = spl_token::state::Account::unpack(&dest_token.try_borrow_data()?)
        .map_err(|_| EscrowError::InvalidTokenAccount)?;
    if dest_state.mint != mint_pk {
        msg!("dest mint mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }
    if dest_state.owner != collector_pk {
        msg!("dest owner mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }

    let balance = fee_vault_state.amount;
    let withdraw_amount = if amount == 0 { balance } else { amount };
    if withdraw_amount > balance {
        msg!("withdraw amount exceeds balance");
        return Err(EscrowError::InvalidInstruction.into());
    }
    if withdraw_amount == 0 {
        return Ok(());
    }

    let transfer_ix = spl_token::instruction::transfer(
        token_program.key,
        fee_vault.key,
        dest_token.key,
        trade_config.key,
        &[],
        withdraw_amount,
    )?;
    invoke_signed(
        &transfer_ix,
        &[
            fee_vault.clone(),
            dest_token.clone(),
            trade_config.clone(),
            token_program.clone(),
        ],
        &[&[TRADE_CONFIG_SEED, fee_collector.key.as_ref(), &[bump]]],
    )?;

    Ok(())
}

fn process_init_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    fee_collector: Pubkey,
    fee_bps: u16,
) -> ProgramResult {
    // Accounts:
    // 0 [signer,writable] payer (also config authority)
    // 1 [writable] config PDA
    // 2 [] system program
    // 3 [] rent sysvar
    let acc_iter = &mut accounts.iter();
    let payer = next_account_info(acc_iter)?;
    let config = next_account_info(acc_iter)?;
    let system_program = next_account_info(acc_iter)?;
    let rent_sysvar = next_account_info(acc_iter)?;

    assert_signer(payer)?;
    assert_writable(payer)?;
    assert_writable(config)?;

    if fee_bps > MAX_PLATFORM_FEE_BPS {
        msg!("fee_bps too high");
        return Err(EscrowError::FeeTooHigh.into());
    }
    if *payer.key != fee_collector {
        msg!("fee_collector must be the config authority");
        return Err(EscrowError::InvalidSigner.into());
    }

    let (expected_config, bump) = config_pda(program_id);
    if expected_config != *config.key {
        msg!("config PDA mismatch");
        return Err(EscrowError::InvalidConfigPda.into());
    }

    if !config.data_is_empty() {
        msg!("config already initialized");
        return Err(EscrowError::AlreadyInitialized.into());
    }

    let rent = Rent::from_account_info(rent_sysvar)?;
    let space = 1usize + 32 + 32 + 2 + 1; // ConfigState layout
    let lamports = rent.minimum_balance(space);
    invoke_signed(
        &system_instruction::create_account(payer.key, config.key, lamports, space as u64, program_id),
        &[payer.clone(), config.clone(), system_program.clone()],
        &[&[CONFIG_SEED, &[bump]]],
    )?;

    let state = ConfigState {
        v: ConfigState::V1,
        authority: payer.key.to_bytes(),
        fee_collector: fee_collector.to_bytes(),
        fee_bps,
        bump,
    };
    state
        .serialize(&mut &mut config.try_borrow_mut_data()?[..])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(())
}

fn process_set_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    fee_collector: Pubkey,
    fee_bps: u16,
) -> ProgramResult {
    // Accounts:
    // 0 [signer] authority
    // 1 [writable] config PDA
    let acc_iter = &mut accounts.iter();
    let authority = next_account_info(acc_iter)?;
    let config = next_account_info(acc_iter)?;

    assert_signer(authority)?;
    assert_writable(config)?;

    if fee_bps > MAX_PLATFORM_FEE_BPS {
        msg!("fee_bps too high");
        return Err(EscrowError::FeeTooHigh.into());
    }
    if *authority.key != fee_collector {
        msg!("fee_collector must be the config authority");
        return Err(EscrowError::InvalidSigner.into());
    }

    let (expected_config, bump) = config_pda(program_id);
    if expected_config != *config.key {
        msg!("config PDA mismatch");
        return Err(EscrowError::InvalidConfigPda.into());
    }

    let mut state =
        ConfigState::try_from_slice(&config.try_borrow_data()?).map_err(|_| EscrowError::InvalidConfigState)?;
    if state.v != ConfigState::V1 || state.bump != bump {
        msg!("config state version/bump mismatch");
        return Err(EscrowError::InvalidConfigState.into());
    }
    if Pubkey::new_from_array(state.authority) != *authority.key {
        msg!("config authority mismatch");
        return Err(EscrowError::InvalidSigner.into());
    }

    state.fee_collector = fee_collector.to_bytes();
    state.fee_bps = fee_bps;
    state
        .serialize(&mut &mut config.try_borrow_mut_data()?[..])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(())
}

fn process_withdraw_fees(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    // Accounts:
    // 0 [signer] fee collector (config authority)
    // 1 [] config PDA
    // 2 [writable] fee vault ATA (ATA(owner=config PDA, mint=configured mint))
    // 3 [writable] fee collector token account (destination)
    // 4 [] token program
    let acc_iter = &mut accounts.iter();
    let fee_collector = next_account_info(acc_iter)?;
    let config = next_account_info(acc_iter)?;
    let fee_vault = next_account_info(acc_iter)?;
    let dest_token = next_account_info(acc_iter)?;
    let token_program = next_account_info(acc_iter)?;

    assert_signer(fee_collector)?;
    assert_writable(fee_vault)?;
    assert_writable(dest_token)?;

    let (expected_config, bump) = config_pda(program_id);
    if expected_config != *config.key {
        msg!("config PDA mismatch");
        return Err(EscrowError::InvalidConfigPda.into());
    }

    let state =
        ConfigState::try_from_slice(&config.try_borrow_data()?).map_err(|_| EscrowError::InvalidConfigState)?;
    if state.v != ConfigState::V1 || state.bump != bump {
        msg!("config state version/bump mismatch");
        return Err(EscrowError::InvalidConfigState.into());
    }

    let auth_pk = Pubkey::new_from_array(state.authority);
    if auth_pk != *fee_collector.key {
        msg!("withdraw signer mismatch");
        return Err(EscrowError::InvalidSigner.into());
    }
    let collector_pk = Pubkey::new_from_array(state.fee_collector);
    if collector_pk != *fee_collector.key {
        msg!("fee_collector mismatch");
        return Err(EscrowError::InvalidSigner.into());
    }

    // Validate fee vault ATA matches ATA(owner=config PDA, mint=fee vault mint).
    let fee_vault_state = spl_token::state::Account::unpack(&fee_vault.try_borrow_data()?)
        .map_err(|_| EscrowError::InvalidTokenAccount)?;
    if fee_vault_state.owner != *config.key {
        msg!("fee vault owner mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }
    let mint_pk = fee_vault_state.mint;
    let expected_fee_vault =
        spl_associated_token_account::get_associated_token_address(config.key, &mint_pk);
    if expected_fee_vault != *fee_vault.key {
        msg!("fee vault ATA mismatch");
        return Err(EscrowError::InvalidFeeVaultAta.into());
    }

    // Validate destination token account: same mint, owned by collector.
    let dest_state = spl_token::state::Account::unpack(&dest_token.try_borrow_data()?)
        .map_err(|_| EscrowError::InvalidTokenAccount)?;
    if dest_state.mint != mint_pk {
        msg!("dest mint mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }
    if dest_state.owner != collector_pk {
        msg!("dest owner mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }

    let balance = fee_vault_state.amount;
    let withdraw_amount = if amount == 0 { balance } else { amount };
    if withdraw_amount > balance {
        msg!("withdraw amount exceeds balance");
        return Err(EscrowError::InvalidInstruction.into());
    }
    if withdraw_amount == 0 {
        return Ok(());
    }

    let transfer_ix = spl_token::instruction::transfer(
        token_program.key,
        fee_vault.key,
        dest_token.key,
        config.key,
        &[],
        withdraw_amount,
    )?;
    invoke_signed(
        &transfer_ix,
        &[fee_vault.clone(), dest_token.clone(), config.clone(), token_program.clone()],
        &[&[CONFIG_SEED, &[bump]]],
    )?;

    Ok(())
}

fn process_init(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payment_hash: [u8; 32],
    recipient: Pubkey,
    refund: Pubkey,
    refund_after: i64,
    amount: u64,
    expected_platform_fee_bps: u16,
    expected_trade_fee_bps: u16,
    trade_fee_collector: Pubkey,
) -> ProgramResult {
    // Accounts:
    // 0 [signer,writable] payer/refund authority (initial depositor)
    // 1 [writable] payer token account (USDT)
    // 2 [writable] escrow PDA (state account)
    // 3 [writable] vault ATA for escrow PDA + mint
    // 4 [] mint
    // 5 [] system program
    // 6 [] token program
    // 7 [] associated token program
    // 8 [] rent sysvar
    // 9 [] config PDA
    // 10 [writable] platform fee vault ATA (ATA(owner=config PDA, mint))
    // 11 [] trade config PDA (seeded by trade_fee_collector)
    // 12 [writable] trade fee vault ATA (ATA(owner=trade config PDA, mint))
    let acc_iter = &mut accounts.iter();
    let payer = next_account_info(acc_iter)?;
    let payer_token = next_account_info(acc_iter)?;
    let escrow = next_account_info(acc_iter)?;
    let vault = next_account_info(acc_iter)?;
    let mint = next_account_info(acc_iter)?;
    let system_program = next_account_info(acc_iter)?;
    let token_program = next_account_info(acc_iter)?;
    let ata_program = next_account_info(acc_iter)?;
    let rent_sysvar = next_account_info(acc_iter)?;
    let config = next_account_info(acc_iter)?;
    let platform_fee_vault = next_account_info(acc_iter)?;
    let trade_config = next_account_info(acc_iter)?;
    let trade_fee_vault = next_account_info(acc_iter)?;

    assert_signer(payer)?;
    assert_writable(payer)?;
    assert_writable(payer_token)?;
    assert_writable(escrow)?;
    assert_writable(vault)?;

    let (expected_escrow, bump) = pda_for_hash(program_id, &payment_hash);
    if expected_escrow != *escrow.key {
        msg!("escrow PDA mismatch");
        return Err(EscrowError::InvalidEscrowPda.into());
    }

    let (expected_config, config_bump) = config_pda(program_id);
    if expected_config != *config.key {
        msg!("config PDA mismatch");
        return Err(EscrowError::InvalidConfigPda.into());
    }
    if config.data_is_empty() {
        msg!("config not initialized");
        return Err(EscrowError::InvalidConfigState.into());
    }
    let config_state =
        ConfigState::try_from_slice(&config.try_borrow_data()?).map_err(|_| EscrowError::InvalidConfigState)?;
    if config_state.v != ConfigState::V1 || config_state.bump != config_bump {
        msg!("config state version/bump mismatch");
        return Err(EscrowError::InvalidConfigState.into());
    }
    if config_state.fee_bps > MAX_PLATFORM_FEE_BPS {
        msg!("config fee_bps too high");
        return Err(EscrowError::FeeTooHigh.into());
    }
    let fee_collector_pk = Pubkey::new_from_array(config_state.fee_collector);
    if config_state.fee_bps != expected_platform_fee_bps {
        msg!("platform fee_bps mismatch vs expected");
        return Err(EscrowError::FeeMismatch.into());
    }

    let expected_vault = spl_associated_token_account::get_associated_token_address(escrow.key, mint.key);
    if expected_vault != *vault.key {
        msg!("vault ATA mismatch");
        return Err(EscrowError::InvalidVaultAta.into());
    }

    // Validate trade config PDA + state.
    let (expected_trade_cfg, trade_cfg_bump) = trade_config_pda(program_id, &trade_fee_collector);
    if expected_trade_cfg != *trade_config.key {
        msg!("trade config PDA mismatch");
        return Err(EscrowError::InvalidTradeConfigPda.into());
    }
    if trade_config.data_is_empty() {
        msg!("trade config not initialized");
        return Err(EscrowError::InvalidTradeConfigState.into());
    }
    let trade_cfg_state = TradeConfigState::try_from_slice(&trade_config.try_borrow_data()?)
        .map_err(|_| EscrowError::InvalidTradeConfigState)?;
    if trade_cfg_state.v != TradeConfigState::V1 || trade_cfg_state.bump != trade_cfg_bump {
        msg!("trade config state version/bump mismatch");
        return Err(EscrowError::InvalidTradeConfigState.into());
    }
    if trade_cfg_state.fee_bps > MAX_TRADE_FEE_BPS {
        msg!("trade config fee_bps too high");
        return Err(EscrowError::FeeTooHigh.into());
    }
    if Pubkey::new_from_array(trade_cfg_state.fee_collector) != trade_fee_collector {
        msg!("trade config fee_collector mismatch");
        return Err(EscrowError::InvalidTradeConfigState.into());
    }
    if Pubkey::new_from_array(trade_cfg_state.authority) != trade_fee_collector {
        msg!("trade config authority mismatch");
        return Err(EscrowError::InvalidTradeConfigState.into());
    }
    if trade_cfg_state.fee_bps != expected_trade_fee_bps {
        msg!("trade fee_bps mismatch vs expected");
        return Err(EscrowError::FeeMismatch.into());
    }

    let total_fee_bps: u32 = config_state.fee_bps as u32 + trade_cfg_state.fee_bps as u32;
    if total_fee_bps > MAX_TOTAL_FEE_BPS as u32 {
        msg!("total fee_bps too high");
        return Err(EscrowError::FeeTooHigh.into());
    }

    // Ensure platform fee vault ATA exists (ATA(owner=config PDA, mint)).
    assert_writable(platform_fee_vault)?;
    let expected_fee_vault =
        spl_associated_token_account::get_associated_token_address(config.key, mint.key);
    if expected_fee_vault != *platform_fee_vault.key {
        msg!("platform fee vault ATA mismatch");
        return Err(EscrowError::InvalidFeeVaultAta.into());
    }
    if platform_fee_vault.data_is_empty() {
        let ix = spl_associated_token_account::instruction::create_associated_token_account(
            payer.key,
            config.key,
            mint.key,
            token_program.key,
        );
        invoke(
            &ix,
            &[
                payer.clone(),
                platform_fee_vault.clone(),
                config.clone(),
                mint.clone(),
                system_program.clone(),
                token_program.clone(),
                ata_program.clone(),
                rent_sysvar.clone(),
            ],
        )?;
    }

    // Ensure trade fee vault ATA exists (ATA(owner=trade config PDA, mint)).
    assert_writable(trade_fee_vault)?;
    let expected_trade_fee_vault =
        spl_associated_token_account::get_associated_token_address(trade_config.key, mint.key);
    if expected_trade_fee_vault != *trade_fee_vault.key {
        msg!("trade fee vault ATA mismatch");
        return Err(EscrowError::InvalidTradeFeeVaultAta.into());
    }
    if trade_fee_vault.data_is_empty() {
        let ix = spl_associated_token_account::instruction::create_associated_token_account(
            payer.key,
            trade_config.key,
            mint.key,
            token_program.key,
        );
        invoke(
            &ix,
            &[
                payer.clone(),
                trade_fee_vault.clone(),
                trade_config.clone(),
                mint.clone(),
                system_program.clone(),
                token_program.clone(),
                ata_program.clone(),
                rent_sysvar.clone(),
            ],
        )?;
    }

    // Validate payer token account.
    let payer_token_state = spl_token::state::Account::unpack(&payer_token.try_borrow_data()?)
        .map_err(|_| EscrowError::InvalidTokenAccount)?;
    if payer_token_state.owner != *payer.key {
        msg!("payer token owner mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }
    if payer_token_state.mint != *mint.key {
        msg!("payer token mint mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }

    let platform_fee_amount_u128 = (amount as u128)
        .checked_mul(config_state.fee_bps as u128)
        .ok_or(EscrowError::InvalidInstruction)?
        / 10_000u128;
    let platform_fee_amount: u64 = platform_fee_amount_u128
        .try_into()
        .map_err(|_| EscrowError::InvalidInstruction)?;

    let trade_fee_amount_u128 = (amount as u128)
        .checked_mul(trade_cfg_state.fee_bps as u128)
        .ok_or(EscrowError::InvalidInstruction)?
        / 10_000u128;
    let trade_fee_amount: u64 = trade_fee_amount_u128
        .try_into()
        .map_err(|_| EscrowError::InvalidInstruction)?;

    let total_amount: u64 = amount
        .checked_add(platform_fee_amount)
        .ok_or(EscrowError::InvalidInstruction)?
        .checked_add(trade_fee_amount)
        .ok_or(EscrowError::InvalidInstruction)?;

    if payer_token_state.amount < total_amount {
        msg!("payer token insufficient balance");
        return Err(EscrowError::InvalidTokenAccount.into());
    }

    // Create escrow PDA account if uninitialized; disallow re-init to keep payment_hash unique.
    if !escrow.data_is_empty() {
        msg!("escrow already initialized");
        return Err(EscrowError::AlreadyInitialized.into());
    }
    {
        let rent = Rent::from_account_info(rent_sysvar)?;
        let space = 1usize
            + 1usize
            + 32
            + 32
            + 32
            + 8
            + 32
            + 8
            + 8
            + 2
            + 32
            + 8
            + 2
            + 32
            + 32
            + 1; // EscrowState layout (v3)
        let lamports = rent.minimum_balance(space);
        invoke_signed(
            &system_instruction::create_account(payer.key, escrow.key, lamports, space as u64, program_id),
            &[payer.clone(), escrow.clone(), system_program.clone()],
            &[&[ESCROW_SEED, &payment_hash, &[bump]]],
        )?;
    }

    // Create vault ATA if needed.
    if vault.data_is_empty() {
        let ix = spl_associated_token_account::instruction::create_associated_token_account(
            payer.key,
            escrow.key,
            mint.key,
            token_program.key,
        );
        invoke(
            &ix,
            &[
                payer.clone(),
                vault.clone(),
                escrow.clone(),
                mint.clone(),
                system_program.clone(),
                token_program.clone(),
                ata_program.clone(),
                rent_sysvar.clone(),
            ],
        )?;
    }

    // Transfer tokens into the vault (net + platform fee + trade fee).
    let transfer_ix = spl_token::instruction::transfer(
        token_program.key,
        payer_token.key,
        vault.key,
        payer.key,
        &[],
        total_amount,
    )?;
    invoke(&transfer_ix, &[payer_token.clone(), vault.clone(), payer.clone(), token_program.clone()])?;

    // Persist state.
    let state = EscrowState {
        v: EscrowState::V3,
        status: EscrowState::STATUS_ACTIVE,
        payment_hash,
        recipient: recipient.to_bytes(),
        refund: refund.to_bytes(),
        refund_after,
        mint: mint.key.to_bytes(),
        net_amount: amount,
        platform_fee_amount,
        platform_fee_bps: config_state.fee_bps,
        platform_fee_collector: fee_collector_pk.to_bytes(),
        trade_fee_amount,
        trade_fee_bps: trade_cfg_state.fee_bps,
        trade_fee_collector: trade_fee_collector.to_bytes(),
        vault: vault.key.to_bytes(),
        bump,
    };
    state
        .serialize(&mut &mut escrow.try_borrow_mut_data()?[..])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(())
}

fn process_claim(program_id: &Pubkey, accounts: &[AccountInfo], preimage: [u8; 32]) -> ProgramResult {
    // Accounts:
    // 0 [signer] recipient
    // 1 [writable] escrow PDA (state account)
    // 2 [writable] vault ATA
    // 3 [writable] recipient token account
    // 4 [writable] platform fee vault ATA (ATA(owner=config PDA, mint))
    // 5 [writable] trade fee vault ATA (ATA(owner=trade config PDA, mint))
    // 6 [] token program
    let acc_iter = &mut accounts.iter();
    let recipient = next_account_info(acc_iter)?;
    let escrow = next_account_info(acc_iter)?;
    let vault = next_account_info(acc_iter)?;
    let recipient_token = next_account_info(acc_iter)?;
    let platform_fee_vault = next_account_info(acc_iter)?;
    let trade_fee_vault = next_account_info(acc_iter)?;
    let token_program = next_account_info(acc_iter)?;

    assert_signer(recipient)?;
    assert_writable(escrow)?;
    assert_writable(vault)?;
    assert_writable(recipient_token)?;
    assert_writable(platform_fee_vault)?;
    assert_writable(trade_fee_vault)?;

    let mut state = EscrowState::try_from_slice(&escrow.try_borrow_data()?)
        .map_err(|_| ProgramError::InvalidAccountData)?;
    require_active(&state)?;

    let recipient_pk = Pubkey::new_from_array(state.recipient);
    if recipient_pk != *recipient.key {
        msg!("recipient mismatch");
        return Err(EscrowError::InvalidSigner.into());
    }
    if Pubkey::new_from_array(state.vault) != *vault.key {
        msg!("vault mismatch");
        return Err(EscrowError::InvalidVaultAta.into());
    }

    let payment_hash = hash(&preimage).to_bytes();
    if payment_hash != state.payment_hash {
        msg!("invalid preimage");
        return Err(EscrowError::InvalidPreimage.into());
    }

    // Validate vault + recipient token accounts.
    let vault_state = spl_token::state::Account::unpack(&vault.try_borrow_data()?)
        .map_err(|_| EscrowError::InvalidTokenAccount)?;
    let recipient_token_state = spl_token::state::Account::unpack(&recipient_token.try_borrow_data()?)
        .map_err(|_| EscrowError::InvalidTokenAccount)?;

    let mint_pk = Pubkey::new_from_array(state.mint);
    if vault_state.mint != mint_pk || recipient_token_state.mint != mint_pk {
        msg!("mint mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }
    if recipient_token_state.owner != *recipient.key {
        msg!("recipient token owner mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }

    let (expected_escrow, bump) = pda_for_hash(program_id, &state.payment_hash);
    if expected_escrow != *escrow.key || bump != state.bump {
        msg!("escrow PDA mismatch");
        return Err(EscrowError::InvalidEscrowPda.into());
    }
    if vault_state.owner != expected_escrow {
        msg!("vault authority mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }

    // Validate platform fee vault ATA (ATA(owner=config PDA, mint)).
    let (cfg_pda, _cfg_bump) = config_pda(program_id);
    let expected_fee_vault =
        spl_associated_token_account::get_associated_token_address(&cfg_pda, &mint_pk);
    if expected_fee_vault != *platform_fee_vault.key {
        msg!("platform fee vault ATA mismatch");
        return Err(EscrowError::InvalidFeeVaultAta.into());
    }
    let platform_fee_vault_state = spl_token::state::Account::unpack(&platform_fee_vault.try_borrow_data()?)
        .map_err(|_| EscrowError::InvalidTokenAccount)?;
    if platform_fee_vault_state.mint != mint_pk {
        msg!("platform fee vault mint mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }
    if platform_fee_vault_state.owner != cfg_pda {
        msg!("platform fee vault owner mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }

    // Validate trade fee vault ATA (ATA(owner=trade config PDA, mint)).
    let trade_collector_pk = Pubkey::new_from_array(state.trade_fee_collector);
    let (trade_cfg_pda, _trade_cfg_bump) = trade_config_pda(program_id, &trade_collector_pk);
    let expected_trade_fee_vault =
        spl_associated_token_account::get_associated_token_address(&trade_cfg_pda, &mint_pk);
    if expected_trade_fee_vault != *trade_fee_vault.key {
        msg!("trade fee vault ATA mismatch");
        return Err(EscrowError::InvalidTradeFeeVaultAta.into());
    }
    let trade_fee_vault_state = spl_token::state::Account::unpack(&trade_fee_vault.try_borrow_data()?)
        .map_err(|_| EscrowError::InvalidTokenAccount)?;
    if trade_fee_vault_state.mint != mint_pk {
        msg!("trade fee vault mint mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }
    if trade_fee_vault_state.owner != trade_cfg_pda {
        msg!("trade fee vault owner mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }

    // Transfer net amount to recipient, then fees to their respective fee vaults.
    let net_amount = state.net_amount;
    let platform_fee_amount = state.platform_fee_amount;
    let trade_fee_amount = state.trade_fee_amount;
    let bump_seed = [state.bump];
    let seeds: &[&[u8]] = &[ESCROW_SEED, &state.payment_hash, &bump_seed];

    let net_ix = spl_token::instruction::transfer(
        token_program.key,
        vault.key,
        recipient_token.key,
        escrow.key,
        &[],
        net_amount,
    )?;
    invoke_signed(
        &net_ix,
        &[vault.clone(), recipient_token.clone(), escrow.clone(), token_program.clone()],
        &[seeds],
    )?;
    if platform_fee_amount > 0 {
        let fee_ix = spl_token::instruction::transfer(
            token_program.key,
            vault.key,
            platform_fee_vault.key,
            escrow.key,
            &[],
            platform_fee_amount,
        )?;
        invoke_signed(
            &fee_ix,
            &[
                vault.clone(),
                platform_fee_vault.clone(),
                escrow.clone(),
                token_program.clone(),
            ],
            &[seeds],
        )?;
    }
    if trade_fee_amount > 0 {
        let fee_ix = spl_token::instruction::transfer(
            token_program.key,
            vault.key,
            trade_fee_vault.key,
            escrow.key,
            &[],
            trade_fee_amount,
        )?;
        invoke_signed(
            &fee_ix,
            &[vault.clone(), trade_fee_vault.clone(), escrow.clone(), token_program.clone()],
            &[seeds],
        )?;
    }

    state.status = EscrowState::STATUS_CLAIMED;
    state.net_amount = 0;
    state.platform_fee_amount = 0;
    state.trade_fee_amount = 0;
    state
        .serialize(&mut &mut escrow.try_borrow_mut_data()?[..])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(())
}

fn process_refund(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    // Accounts:
    // 0 [signer] refund authority
    // 1 [writable] escrow PDA (state account)
    // 2 [writable] vault ATA
    // 3 [writable] refund token account
    // 4 [] token program
    // 5 [] clock sysvar
    let acc_iter = &mut accounts.iter();
    let refund = next_account_info(acc_iter)?;
    let escrow = next_account_info(acc_iter)?;
    let vault = next_account_info(acc_iter)?;
    let refund_token = next_account_info(acc_iter)?;
    let token_program = next_account_info(acc_iter)?;
    let clock_sysvar = next_account_info(acc_iter)?;

    assert_signer(refund)?;
    assert_writable(escrow)?;
    assert_writable(vault)?;
    assert_writable(refund_token)?;

    let mut state = EscrowState::try_from_slice(&escrow.try_borrow_data()?)
        .map_err(|_| ProgramError::InvalidAccountData)?;
    require_active(&state)?;

    let refund_pk = Pubkey::new_from_array(state.refund);
    if refund_pk != *refund.key {
        msg!("refund signer mismatch");
        return Err(EscrowError::InvalidSigner.into());
    }
    if Pubkey::new_from_array(state.vault) != *vault.key {
        msg!("vault mismatch");
        return Err(EscrowError::InvalidVaultAta.into());
    }

    let clock = Clock::from_account_info(clock_sysvar)?;
    if clock.unix_timestamp < state.refund_after {
        msg!("too early to refund");
        return Err(EscrowError::TooEarly.into());
    }

    let vault_state = spl_token::state::Account::unpack(&vault.try_borrow_data()?)
        .map_err(|_| EscrowError::InvalidTokenAccount)?;
    let refund_token_state = spl_token::state::Account::unpack(&refund_token.try_borrow_data()?)
        .map_err(|_| EscrowError::InvalidTokenAccount)?;

    let mint_pk = Pubkey::new_from_array(state.mint);
    if vault_state.mint != mint_pk || refund_token_state.mint != mint_pk {
        msg!("mint mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }
    if refund_token_state.owner != *refund.key {
        msg!("refund token owner mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }

    let (expected_escrow, bump) = pda_for_hash(program_id, &state.payment_hash);
    if expected_escrow != *escrow.key || bump != state.bump {
        msg!("escrow PDA mismatch");
        return Err(EscrowError::InvalidEscrowPda.into());
    }
    if vault_state.owner != expected_escrow {
        msg!("vault authority mismatch");
        return Err(EscrowError::InvalidTokenAccount.into());
    }

    let total_amount = state
        .net_amount
        .checked_add(state.platform_fee_amount)
        .ok_or(EscrowError::InvalidInstruction)?
        .checked_add(state.trade_fee_amount)
        .ok_or(EscrowError::InvalidInstruction)?;
    let transfer_ix = spl_token::instruction::transfer(
        token_program.key,
        vault.key,
        refund_token.key,
        escrow.key,
        &[],
        total_amount,
    )?;
    invoke_signed(
        &transfer_ix,
        &[vault.clone(), refund_token.clone(), escrow.clone(), token_program.clone()],
        &[&[ESCROW_SEED, &state.payment_hash, &[state.bump]]],
    )?;

    state.status = EscrowState::STATUS_REFUNDED;
    state.net_amount = 0;
    state.platform_fee_amount = 0;
    state.trade_fee_amount = 0;
    state
        .serialize(&mut &mut escrow.try_borrow_mut_data()?[..])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    Ok(())
}
