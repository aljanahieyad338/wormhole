package keeper_test

import (
	"crypto/ecdsa"
	"encoding/binary"
	"testing"
	"time"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/assert"
	keepertest "github.com/wormhole-foundation/wormchain/testutil/keeper"
	"github.com/wormhole-foundation/wormchain/x/wormhole/keeper"
	"github.com/wormhole-foundation/wormchain/x/wormhole/types"
	"github.com/wormhole-foundation/wormhole/sdk/vaa"
)

func createExecuteGovernanceVaaPayload(k *keeper.Keeper, ctx sdk.Context, num_guardians byte) ([]byte, []*ecdsa.PrivateKey) {
	guardians, privateKeys := createNGuardianValidator(k, ctx, int(num_guardians))
	next_index := k.GetGuardianSetCount(ctx)
	set_update := make([]byte, 4)
	binary.BigEndian.PutUint32(set_update, next_index)
	set_update = append(set_update, num_guardians)
	// Add keys to set_update
	for _, guardian := range guardians {
		set_update = append(set_update, guardian.GuardianKey...)
	}
	// governance message with sha3 of wasmBytes as the payload
	module := [32]byte{}
	copy(module[:], vaa.CoreModule)
	gov_msg := types.NewGovernanceMessage(module, byte(vaa.ActionGuardianSetUpdate), uint16(vaa.ChainIDWormchain), set_update)

	return gov_msg.MarshalBinary(), privateKeys
}

func TestExecuteGovernanceVAA(t *testing.T) {
	k, ctx := keepertest.WormholeKeeper(t)
	guardians, privateKeys := createNGuardianValidator(k, ctx, 10)
	_ = privateKeys
	k.SetConfig(ctx, types.Config{
		GovernanceEmitter:     vaa.GovernanceEmitter[:],
		GovernanceChain:       uint32(vaa.GovernanceChain),
		ChainId:               uint32(vaa.ChainIDWormchain),
		GuardianSetExpiration: 86400,
	})
	signer_bz := [20]byte{}
	signer := sdk.AccAddress(signer_bz[:])

	set := createNewGuardianSet(k, ctx, guardians)
	k.SetConsensusGuardianSetIndex(ctx, types.ConsensusGuardianSetIndex{Index: set.Index})

	context := sdk.WrapSDKContext(ctx)
	msgServer := keeper.NewMsgServerImpl(*k)

	// create governance to update guardian set with extra guardian
	payload, newPrivateKeys := createExecuteGovernanceVaaPayload(k, ctx, 11)
	v := generateVaa(set.Index, privateKeys, vaa.ChainID(vaa.GovernanceChain), payload)
	vBz, _ := v.Marshal()
	_, err := msgServer.ExecuteGovernanceVAA(context, &types.MsgExecuteGovernanceVAA{
		Signer: signer.String(),
		Vaa:    vBz,
	})
	assert.NoError(t, err)

	// we should have a new set with 11 guardians now
	new_index := k.GetLatestGuardianSetIndex(ctx)
	assert.Equal(t, set.Index+1, new_index)
	new_set, _ := k.GetGuardianSet(ctx, new_index)
	assert.Len(t, new_set.Keys, 11)

	// Submitting another change with the old set doesn't work
	v = generateVaa(set.Index, privateKeys, vaa.ChainID(vaa.GovernanceChain), payload)
	vBz, _ = v.Marshal()
	_, err = msgServer.ExecuteGovernanceVAA(context, &types.MsgExecuteGovernanceVAA{
		Signer: signer.String(),
		Vaa:    vBz,
	})
	assert.ErrorIs(t, err, types.ErrGuardianSetNotSequential)

	// Invalid length
	v = generateVaa(set.Index, privateKeys, vaa.ChainID(vaa.GovernanceChain), payload[:len(payload)-1])
	vBz, _ = v.Marshal()
	_, err = msgServer.ExecuteGovernanceVAA(context, &types.MsgExecuteGovernanceVAA{
		Signer: signer.String(),
		Vaa:    vBz,
	})
	assert.ErrorIs(t, err, types.ErrInvalidGovernancePayloadLength)

	// Include a guardian address twice in an update
	payload_bad, _ := createExecuteGovernanceVaaPayload(k, ctx, 11)
	copy(payload_bad[len(payload_bad)-20:], payload_bad[len(payload_bad)-40:len(payload_bad)-20])
	v = generateVaa(set.Index, privateKeys, vaa.ChainID(vaa.GovernanceChain), payload_bad)
	vBz, _ = v.Marshal()
	_, err = msgServer.ExecuteGovernanceVAA(context, &types.MsgExecuteGovernanceVAA{
		Signer: signer.String(),
		Vaa:    vBz,
	})
	assert.ErrorIs(t, err, types.ErrDuplicateGuardianAddress)

	// Change set again with new set update
	payload, _ = createExecuteGovernanceVaaPayload(k, ctx, 12)
	v = generateVaa(new_set.Index, newPrivateKeys, vaa.ChainID(vaa.GovernanceChain), payload)
	vBz, _ = v.Marshal()
	_, err = msgServer.ExecuteGovernanceVAA(context, &types.MsgExecuteGovernanceVAA{
		Signer: signer.String(),
		Vaa:    vBz,
	})
	assert.NoError(t, err)
	new_index2 := k.GetLatestGuardianSetIndex(ctx)
	assert.Equal(t, new_set.Index+1, new_index2)
}

func createSlashingParamsUpdatePayload() []byte {
	// 5 int64 values
	slashingParams := make([]byte, 40)

	signedBlocksWindow := uint64(100)
	minSignedPerWindow := sdk.NewDecWithPrec(5, 1).BigInt().Uint64()
	downtimeJailDuration := uint64(600 * time.Second)
	slashFractionDoubleSign := sdk.NewDecWithPrec(5, 2).BigInt().Uint64()
	slashFractionDowntime := sdk.NewDecWithPrec(1, 2).BigInt().Uint64()

	binary.BigEndian.PutUint64(slashingParams, signedBlocksWindow)
	binary.BigEndian.PutUint64(slashingParams[8:], minSignedPerWindow)
	binary.BigEndian.PutUint64(slashingParams[16:], downtimeJailDuration)
	binary.BigEndian.PutUint64(slashingParams[24:], slashFractionDoubleSign)
	binary.BigEndian.PutUint64(slashingParams[32:], slashFractionDowntime)

	// governance message with sha3 of wasmBytes as the payload
	module := [32]byte{}
	copy(module[:], vaa.CoreModule)
	gov_msg := types.NewGovernanceMessage(module, byte(vaa.ActionSlashingParamsUpdate), uint16(vaa.ChainIDWormchain), slashingParams)

	return gov_msg.MarshalBinary()
}

func TestExecuteSlashingParamsUpdate(t *testing.T) {
	k, ctx := keepertest.WormholeKeeper(t)
	guardians, privateKeys := createNGuardianValidator(k, ctx, 10)
	_ = privateKeys
	k.SetConfig(ctx, types.Config{
		GovernanceEmitter:     vaa.GovernanceEmitter[:],
		GovernanceChain:       uint32(vaa.GovernanceChain),
		ChainId:               uint32(vaa.ChainIDWormchain),
		GuardianSetExpiration: 86400,
	})
	signer_bz := [20]byte{}
	signer := sdk.AccAddress(signer_bz[:])

	set := createNewGuardianSet(k, ctx, guardians)
	k.SetConsensusGuardianSetIndex(ctx, types.ConsensusGuardianSetIndex{Index: set.Index})

	context := sdk.WrapSDKContext(ctx)
	msgServer := keeper.NewMsgServerImpl(*k)

	// create governance to update slashing params
	payload := createSlashingParamsUpdatePayload()
	v := generateVaa(set.Index, privateKeys, vaa.ChainID(vaa.GovernanceChain), payload)
	vBz, _ := v.Marshal()
	_, err := msgServer.ExecuteGovernanceVAA(context, &types.MsgExecuteGovernanceVAA{
		Signer: signer.String(),
		Vaa:    vBz,
	})
	assert.NoError(t, err)
}

func createUpdateClientPayload() []byte {
	// 2 64byte strings
	updateClient := make([]byte, 128)

	subjectClientId := "07-tendermint-0"
	substituteClientId := "07-tendermint-1"

	subjectBz := [64]byte{}
	copy(subjectBz[:], subjectClientId)

	substituteBz := [64]byte{}
	copy(substituteBz[:], substituteClientId)

	copy(updateClient, subjectBz[:])
	copy(updateClient[64:], substituteBz[:])

	// governance message with sha3 of wasmBytes as the payload
	module := [32]byte{}
	copy(module[:], vaa.CoreModule)
	gov_msg := types.NewGovernanceMessage(module, byte(vaa.ActionIBCClientUpdate), uint16(vaa.ChainIDWormchain), updateClient)

	return gov_msg.MarshalBinary()
}

func TestExecuteUpdateClientVAA(t *testing.T) {
	k, ctx := keepertest.WormholeKeeper(t)
	guardians, privateKeys := createNGuardianValidator(k, ctx, 10)
	_ = privateKeys
	k.SetConfig(ctx, types.Config{
		GovernanceEmitter:     vaa.GovernanceEmitter[:],
		GovernanceChain:       uint32(vaa.GovernanceChain),
		ChainId:               uint32(vaa.ChainIDWormchain),
		GuardianSetExpiration: 86400,
	})
	signer_bz := [20]byte{}
	signer := sdk.AccAddress(signer_bz[:])

	set := createNewGuardianSet(k, ctx, guardians)
	k.SetConsensusGuardianSetIndex(ctx, types.ConsensusGuardianSetIndex{Index: set.Index})

	context := sdk.WrapSDKContext(ctx)
	msgServer := keeper.NewMsgServerImpl(*k)

	// create governance to update ibc client
	payload := createUpdateClientPayload()
	v := generateVaa(set.Index, privateKeys, vaa.ChainID(vaa.GovernanceChain), payload)
	vBz, _ := v.Marshal()
	_, err := msgServer.ExecuteGovernanceVAA(context, &types.MsgExecuteGovernanceVAA{
		Signer: signer.String(),
		Vaa:    vBz,
	})
	assert.Error(t, err)
	assert.ErrorContains(t, err, "light client not found")
}
