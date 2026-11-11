import React, { useState, useEffect } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Alert } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useUser } from '../context/UserContext';
import { useBooking } from '../context/BookingContext';
import { API_BASE_URL } from '../config/api';
import { navigationRef } from './navigationRef';
import { colors } from '../theme/colors';

// Ensure document.title is always UniServ on web
if (typeof document !== 'undefined') {
  document.title = 'UniServ';
}

// Screens
import Screen01_LanguageSelection from '../screens/Screen01_LanguageSelection';
import Screen02_OTPLogin from '../screens/Screen02_OTPLogin';
import Screen02_Registration from '../screens/Screen02_Registration';
import BottomTabNavigator from './BottomTabNavigator';
import Screen04_ServiceDetail from '../screens/Screen04_ServiceDetail';
import Screen05_BookingForm from '../screens/Screen05_BookingForm';
import Screen06_WorkerMatch from '../screens/Screen06_WorkerMatch';
import Screen07_LiveTracking from '../screens/Screen07_LiveTracking';
import Screen08_StartOTP from '../screens/Screen08_StartOTP';
import Screen09_JobInProgress from '../screens/Screen09_JobInProgress';
import Screen10_ExtraWorkApproval from '../screens/Screen10_ExtraWorkApproval';
import Screen11_CompletionOTP from '../screens/Screen11_CompletionOTP';
import Screen12_PaymentScreen from '../screens/Screen12_PaymentScreen';
import Screen12_BulkPaymentScreen from '../screens/Screen12_BulkPaymentScreen';
import Screen13_PaymentSuccess from '../screens/Screen13_PaymentSuccess';
import Screen13_BulkProjectSuccess from '../screens/Screen13_BulkProjectSuccess';
import Screen14_RatingScreen from '../screens/Screen14_RatingScreen';
import Screen15_NoWorkerAvailable from '../screens/Screen15_NoWorkerAvailable';
import Screen16_ComplaintScreen from '../screens/Screen16_ComplaintScreen';
import Screen17_SevaSurakshaScreen from '../screens/Screen17_SevaSurakshaScreen';
import Screen18_CommunityScreen from '../screens/Screen18_CommunityScreen';
import Screen_RegisterForAnother from '../screens/Screen_RegisterForAnother';
import Screen_IVRSCall from '../screens/Screen_IVRSCall';

const Stack = createNativeStackNavigator();

export const AppNavigator = () => {
  const { isLoggedIn, isLoading, user } = useUser();
  const { setActiveBooking } = useBooking();

  const isFullyRegisteredAndLoggedIn = Boolean(isLoggedIn && user && user.isRegistered);

  const [payPalProcessing, setPayPalProcessing] = useState(() => {
    if (typeof window !== 'undefined' && window.location) {
      const search = window.location.search || '';
      return (
        search.includes('paypal_return=true') ||
        search.includes('paypal_cancel=true') ||
        (search.includes('token=') && search.includes('PayerID='))
      );
    }
    return false;
  });
  const [payPalStatusText, setPayPalStatusText] = useState('Verifying PayPal Sandbox Authorization Hold...');
  const [pendingNavigation, setPendingNavigation] = useState(null);

  // Set document.title on mount
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.title = 'UniServ';
    }
  }, []);

  // Handle return from PayPal sandbox before navigation renders
  useEffect(() => {
    if (!payPalProcessing) return;

    const resolvePayPal = async () => {
      try {
        if (typeof document !== 'undefined') {
          document.title = 'UniServ';
        }
        const search = window.location.search || '';
        const params = new URLSearchParams(search);
        const isCancel = params.get('paypal_cancel') === 'true' || params.get('cancel') === 'true';
        const isReturn = params.get('paypal_return') === 'true' || (params.get('token') && params.get('PayerID'));
        const token = params.get('token');
        const payerId = params.get('PayerID');
        const bookingId = params.get('booking_id');

        const rawDraft = await AsyncStorage.getItem('@uniserv_paypal_booking_draft');
        let draft = null;
        try {
          draft = rawDraft ? JSON.parse(rawDraft) : null;
        } catch (e) {}

        // CASE 1: BUYER CANCELLED ON PAYPAL
        if (isCancel) {
          if (typeof window !== 'undefined' && window.history && window.history.replaceState) {
            window.history.replaceState({}, 'UniServ', window.location.pathname);
          }
          if (draft) {
            await AsyncStorage.setItem('@uniserv_paypal_cancel_notice', 'true');
            setPendingNavigation({
              route: 'BookingForm',
              params: {
                service: draft.service,
                bookingType: draft.booking_type,
                restoredDraft: draft
              }
            });
          }
          setPayPalProcessing(false);
          return;
        }

        // CASE 2: BUYER APPROVED ON PAYPAL
        if (isReturn) {
          // Double-auth prevention: if page was refreshed after return and already authorized
          if (draft && draft.status === 'AUTHORIZED' && draft.paypal_authorization_id) {
            if (typeof window !== 'undefined' && window.history && window.history.replaceState) {
              window.history.replaceState({}, 'UniServ', window.location.pathname);
            }
            if (draft.bookingRecord) {
              setActiveBooking(draft.bookingRecord);
            }
            setPendingNavigation({
              route: 'WorkerMatch',
              params: {
                service: draft.service,
                bookingType: draft.booking_type
              }
            });
            setPayPalProcessing(false);
            return;
          }

          setPayPalStatusText('Authorizing PayPal sandbox payment hold with settlement engine...');
          const targetOrderId = token || draft?.orderId;
          const targetBookingId = bookingId || draft?.bookingId;

          const res = await fetch(`${API_BASE_URL}/api/orders/authorize`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              orderId: targetOrderId,
              bookingId: targetBookingId,
              payerId: payerId || null
            })
          });

          const data = await res.json();

          // Clean URL params immediately
          if (typeof window !== 'undefined' && window.history && window.history.replaceState) {
            window.history.replaceState({}, 'UniServ', window.location.pathname);
          }

          if (res.ok && data.success) {
            const bookingRecord = {
              ...(draft?.bookingRecord || draft || {}),
              booking_id: data.bookingId || targetBookingId,
              payment_method: 'PAYPAL_SANDBOX',
              paypal_order_id: data.orderId || targetOrderId,
              paypal_authorization_id: data.authorizationId,
              paypal_mode: data.mode || 'REAL_SANDBOX',
              paypal_status: 'AUTHORIZED',
              paypal_authorized_usd: draft?.authorizedAmountUsd || '4.40',
              paypal_payer: draft?.payer || null,
              status: 'Booking Confirmed',
              statusIndex: 0
            };

            // Save updated draft to prevent re-auth on subsequent refresh
            await AsyncStorage.setItem('@uniserv_paypal_booking_draft', JSON.stringify({
              ...draft,
              status: 'AUTHORIZED',
              paypal_authorization_id: data.authorizationId,
              bookingRecord
            }));

            setActiveBooking(bookingRecord);
            setPendingNavigation({
              route: 'WorkerMatch',
              params: {
                service: bookingRecord.service,
                bookingType: bookingRecord.booking_type
              }
            });
          } else {
            // Handle PayPal errors (ORDER_NOT_APPROVED, INSTRUMENT_DECLINED, etc.)
            const errMsg = data.message || 'PayPal sandbox authorization failed.';
            const debugId = data.debugId || 'none';
            Alert.alert(
              'PayPal Authorization Notice',
              `${errMsg}\n(Debug ID: ${debugId})`
            );
            setPendingNavigation({
              route: 'BookingForm',
              params: {
                service: draft?.service,
                bookingType: draft?.booking_type,
                restoredDraft: draft
              }
            });
          }
        }
      } catch (err) {
        console.error('PayPal return resolution error:', err);
        Alert.alert(
          'Payment Notice',
          'Payment server not reachable. Please ensure the UniServ API server is running on port 5000.'
        );
        if (typeof window !== 'undefined' && window.history && window.history.replaceState) {
          window.history.replaceState({}, 'UniServ', window.location.pathname);
        }
        setPendingNavigation({ route: 'BookingForm' });
      } finally {
        setPayPalProcessing(false);
      }
    };

    resolvePayPal();
  }, [payPalProcessing]);

  // Navigate to target screen once navigator is mounted and user is logged in
  useEffect(() => {
    if (!pendingNavigation || !isFullyRegisteredAndLoggedIn) return;

    let mounted = true;
    let attempts = 0;

    const tryNavigate = () => {
      if (!mounted) return;
      if (navigationRef.current && typeof navigationRef.current.navigate === 'function') {
        try {
          navigationRef.current.navigate(pendingNavigation.route, pendingNavigation.params);
          setPendingNavigation(null);
          return;
        } catch (e) {
          console.warn('Navigation attempt waiting for navigator readiness:', e.message);
        }
      }
      attempts++;
      if (attempts < 25) {
        setTimeout(tryNavigate, 100);
      }
    };

    const timer = setTimeout(tryNavigate, 150);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [pendingNavigation, isFullyRegisteredAndLoggedIn]);

  // Initial Loading Splash Screen or Return Processing
  if (isLoading || payPalProcessing) {
    return (
      <View style={styles.splashContainer}>
        <View style={styles.splashIconCircle}>
          <Ionicons name="shield-checkmark" size={42} color="#FFFFFF" />
        </View>
        <Text style={styles.splashGovTag}>UNISERV COOPERATIVE GIG PLATFORM</Text>
        <Text style={styles.splashTitle}>UniServ</Text>
        <Text style={styles.splashSub}>Independent Prototype • Sandbox Payments Only</Text>
        <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 24 }} />
        <Text style={styles.splashStatusText}>
          {payPalProcessing ? payPalStatusText : 'Initializing Cooperative Platform & Sandbox Services...'}
        </Text>
      </View>
    );
  }

  return (
    <Stack.Navigator
      initialRouteName={isFullyRegisteredAndLoggedIn ? 'MainTabs' : 'OTPLogin'}
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right'
      }}
    >
      {!isFullyRegisteredAndLoggedIn ? (
        // -------------------------------------------------------------------
        // UNAUTHENTICATED STACK (OTPLogin / LanguageSelection / Registration)
        // -------------------------------------------------------------------
        <Stack.Group>
          <Stack.Screen name="OTPLogin" component={Screen02_OTPLogin} />
          <Stack.Screen name="LanguageSelection" component={Screen01_LanguageSelection} />
          <Stack.Screen name="Registration" component={Screen02_Registration} />
        </Stack.Group>
      ) : (
        // -------------------------------------------------------------------
        // AUTHENTICATED STACK (MainTabs & Service Workflows)
        // -------------------------------------------------------------------
        <Stack.Group>
          {/* Main Tabbed App */}
          <Stack.Screen name="MainTabs" component={BottomTabNavigator} />
          <Stack.Screen name="Home" component={BottomTabNavigator} />

          {/* Community & Society Bulk Hub */}
          <Stack.Screen name="Community" component={Screen18_CommunityScreen} />

          {/* Service Request & Matching Flow */}
          <Stack.Screen
            name="ServiceDetail"
            component={Screen04_ServiceDetail}
          />
          <Stack.Screen
            name="BookingForm"
            component={Screen05_BookingForm}
          />
          <Stack.Screen
            name="WorkerMatch"
            component={Screen06_WorkerMatch}
          />
          <Stack.Screen name="NoWorkerAvailable" component={Screen15_NoWorkerAvailable} />

          {/* Live Tracking & Execution Flow */}
          <Stack.Screen name="LiveTracking" component={Screen07_LiveTracking} />
          <Stack.Screen name="StartOTP" component={Screen08_StartOTP} />
          <Stack.Screen name="JobInProgress" component={Screen09_JobInProgress} />
          <Stack.Screen name="ExtraWorkApproval" component={Screen10_ExtraWorkApproval} />
          <Stack.Screen name="CompletionOTP" component={Screen11_CompletionOTP} />

          {/* Payment & Settlement Flow */}
          <Stack.Screen name="Payment" component={Screen12_PaymentScreen} />
          <Stack.Screen name="BulkPayment" component={Screen12_BulkPaymentScreen} />
          <Stack.Screen name="PaymentSuccess" component={Screen13_PaymentSuccess} />
          <Stack.Screen name="BulkProjectSuccess" component={Screen13_BulkProjectSuccess} />
          <Stack.Screen name="Rating" component={Screen14_RatingScreen} />
          <Stack.Screen name="RatingScreen" component={Screen14_RatingScreen} />

          {/* Seva Suraksha & Grievance Modals */}
          <Stack.Screen
            name="Complaint"
            component={Screen16_ComplaintScreen}
            options={{ animation: 'slide_from_bottom' }}
          />
          <Stack.Screen
            name="SevaSuraksha"
            component={Screen17_SevaSurakshaScreen}
            options={{ animation: 'slide_from_bottom' }}
          />
          <Stack.Screen
            name="RegisterForAnother"
            component={Screen_RegisterForAnother}
          />
          <Stack.Screen
            name="IVRSCall"
            component={Screen_IVRSCall}
            options={{ animation: 'slide_from_bottom' }}
          />
        </Stack.Group>
      )}
    </Stack.Navigator>
  );
};

const styles = StyleSheet.create({
  splashContainer: {
    flex: 1,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24
  },
  splashIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4
  },
  splashGovTag: {
    fontSize: 9,
    fontWeight: '900',
    color: '#94A3B8',
    letterSpacing: 1,
    marginBottom: 6
  },
  splashTitle: {
    fontSize: 28,
    fontWeight: '900',
    color: '#FFFFFF'
  },
  splashSub: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 4,
    textAlign: 'center'
  },
  splashStatusText: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 14,
    textAlign: 'center',
    letterSpacing: 0.2
  }
});

export default AppNavigator;
