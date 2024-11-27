package keeper

import (
	"context"
	"encoding/binary"
	"fmt"
	"time"

	sdk "github.com/cosmos/cosmos-sdk/types"
	slashingtypes "github.com/cosmos/cosmos-sdk/x/slashing/types"
	clienttypes "github.com/cosmos/ibc-go/v4/modules/core/02-client/types"
	"github.com/wormhole-foundation/wormchain/x/wormhole/types"
	"github.com/wormhole-foundation/wormhole/sdk/vaa"
)

func (k msgServer) ExecuteGovernanceVAA(goCtx context.Context, msg *types.MsgExecuteGovernanceVAA) (*types.MsgExecuteGovernanceVAAResponse, error) {
	ctx := sdk.UnwrapSDKContext(goCtx)

	// Parse VAA
	v, err := ParseVAA(msg.Vaa)
	if err != nil {
		return nil, err
	}

	coreModule := [32]byte{}
	copy(coreModule[:], vaa.CoreModule)
	// Verify VAA
	action, payload, err := k.VerifyGovernanceVAA(ctx, v, coreModule)
	if err != nil {
		return nil, err
	}

	// Execute action
	switch vaa.GovernanceAction(action) {
	case vaa.ActionGuardianSetUpdate:
		if len(payload) < 5 {
			return nil, types.ErrInvalidGovernancePayloadLength
		}
		// Update guardian set
		newIndex := binary.BigEndian.Uint32(payload[:4])
		numGuardians := int(payload[4])

		if len(payload) != 5+20*numGuardians {
			return nil, types.ErrInvalidGovernancePayloadLength
		}

		added := make(map[string]bool)
		var keys [][]byte
		for i := 0; i < numGuardians; i++ {
			k := payload[5+i*20 : 5+i*20+20]
			sk := string(k)
			if _, found := added[sk]; found {
				return nil, types.ErrDuplicateGuardianAddress
			}
			keys = append(keys, k)
			added[sk] = true
		}

		err := k.UpdateGuardianSet(ctx, types.GuardianSet{
			Keys:  keys,
			Index: newIndex,
		})
		if err != nil {
			return nil, err
		}
	case vaa.ActionSlashingParamsUpdate:
		if len(payload) != 40 {
			return nil, types.ErrInvalidGovernancePayloadLength
		}

		// Extract params from payload
		signedBlocksWindow := int64(binary.BigEndian.Uint64(payload[:8]))
		minSignedPerWindow := int64(binary.BigEndian.Uint64(payload[8:16]))
		downtimeJailDuration := int64(binary.BigEndian.Uint64(payload[16:24]))
		slashFractionDoubleSign := int64(binary.BigEndian.Uint64(payload[24:32]))
		slashFractionDowntime := int64(binary.BigEndian.Uint64(payload[32:40]))

		// Update slashing params
		params := slashingtypes.NewParams(
			signedBlocksWindow,
			sdk.NewDecWithPrec(minSignedPerWindow, 18),
			time.Duration(downtimeJailDuration),
			sdk.NewDecWithPrec(slashFractionDoubleSign, 18),
			sdk.NewDecWithPrec(slashFractionDowntime, 18),
		)

		// Set the new params
		//
		// TODO: Once upgraded to CosmosSDK v0.47, this method will return an error
		// if the params do not pass validation checks. Because of that, we need to
		// return the error from this function.
		k.slashingKeeper.SetParams(ctx, params)
	case vaa.ActionUpdateIBCClient:
		if len(payload) != 128 {
			return nil, types.ErrInvalidGovernancePayloadLength
		}

		subjectClientId := string(payload[0:64])
		substituteClientId := string(payload[64:128])

		msg := clienttypes.ClientUpdateProposal{
			Title:              "Update IBC Client",
			Description:        fmt.Sprintf("Updates Client %s with %s", subjectClientId, substituteClientId),
			SubjectClientId:    subjectClientId,
			SubstituteClientId: substituteClientId,
		}

		err := k.clientKeeper.ClientUpdateProposal(ctx, &msg)
		if err != nil {
			return nil, err
		}
	default:
		return nil, types.ErrUnknownGovernanceAction

	}

	return &types.MsgExecuteGovernanceVAAResponse{}, nil
}
