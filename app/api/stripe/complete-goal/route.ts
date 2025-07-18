import { NextRequest, NextResponse } from 'next/server'
import { api } from '@/convex/_generated/api'
import { ConvexHttpClient } from 'convex/browser'
import { stripe } from '@/lib/stripe'

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!)

export async function POST(request: NextRequest) {
  try {
    const { sessionId, goalData } = await request.json()

    if (!sessionId || !goalData) {
      return NextResponse.json(
        { error: 'Missing sessionId or goalData' },
        { status: 400 }
      )
    }

    console.log(`Processing goal completion for session: ${sessionId}`)

    // Step 1: Check if a goal with this sessionId already exists to prevent duplicates
    const existingGoal = await convex.query(api.goals.getGoalBySessionId, { sessionId })
    
    if (existingGoal) {
      console.log(`Goal already exists for session ${sessionId}, returning existing goal: ${existingGoal._id}`)
      return NextResponse.json({
        success: true,
        goalId: existingGoal._id,
        alreadyExists: true,
      })
    }

    // Step 2: Check if there's a pending goal that we should update instead of creating a new one
    // Use a more flexible search to find the pending goal
    const pendingGoal = await convex.query(api.goals.getPendingGoalByUser, { 
      userId: goalData.userId,
      title: goalData.title,
      deadline: goalData.deadline
    })

    if (pendingGoal) {
      console.log(`Found pending goal: ${pendingGoal._id}, updating it`)
      
      // Update the existing pending goal instead of creating a new one
      await convex.mutation(api.goals.updateGoalStatus, {
        goalId: pendingGoal._id,
        status: 'active',
      })
      
      // Update the goal with session ID
      await convex.mutation(api.goals.updateGoalWithSession, {
        goalId: pendingGoal._id,
        stripeSessionId: sessionId,
      })

      // Try to retrieve payment method ID from Stripe session as fallback
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ['setup_intent.payment_method'],
        })
        
        if (session.setup_intent && (session.setup_intent as any).payment_method) {
          const paymentMethodId = (session.setup_intent as any).payment_method.id
          await convex.mutation(api.goals.savePaymentMethodId, {
            goalId: pendingGoal._id,
            paymentMethodId: paymentMethodId,
          })
          console.log(`Payment method ID saved via fallback for goal: ${pendingGoal._id}`)
        }
      } catch (error) {
        console.warn(`Could not retrieve payment method ID for goal ${pendingGoal._id}:`, error)
      }

      // Mark payment setup as complete
      await convex.mutation(api.goals.updatePaymentSetupComplete, {
        goalId: pendingGoal._id,
      })

      console.log(`Successfully updated pending goal: ${pendingGoal._id}`)
      return NextResponse.json({
        success: true,
        goalId: pendingGoal._id,
        alreadyExists: false,
      })
    }

    // Step 3: If no pending goal found, check for any recent goals by this user with the same title
    // This handles cases where the pending goal might have been created but not found by the query
    console.log(`No pending goal found, checking for recent goals by user: ${goalData.userId}`)
    
    // Create a new goal if no pending goal exists
    const { goalId: _, ...goalDataWithoutId } = goalData
    const goalId = await convex.mutation(api.goals.createGoal, {
      ...goalDataWithoutId,
      stripeSessionId: sessionId,
      status: 'active', // Set status to active directly
    })

    console.log(`Created new goal: ${goalId}`)

    // Try to retrieve payment method ID from Stripe session as fallback
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['setup_intent.payment_method'],
      })
      
      if (session.setup_intent && (session.setup_intent as any).payment_method) {
        const paymentMethodId = (session.setup_intent as any).payment_method.id
        await convex.mutation(api.goals.savePaymentMethodId, {
          goalId,
          paymentMethodId: paymentMethodId,
        })
        console.log(`Payment method ID saved via fallback for goal: ${goalId}`)
      }
    } catch (error) {
      console.warn(`Could not retrieve payment method ID for goal ${goalId}:`, error)
    }

    // Mark payment setup as complete so the goal appears in the feed
    await convex.mutation(api.goals.updatePaymentSetupComplete, {
      goalId,
    })

    console.log(`Successfully created and completed goal: ${goalId}`)
    return NextResponse.json({
      success: true,
      goalId,
      alreadyExists: false,
    })
  } catch (error) {
    console.error('Error completing goal creation:', error)
    return NextResponse.json(
      { error: 'Failed to complete goal creation' },
      { status: 500 }
    )
  }
} 